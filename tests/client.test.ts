import assert from 'node:assert/strict';
import http from 'node:http';
import { type AddressInfo, connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterEach, test } from 'node:test';
import { describeApiError, isIdempotentPostRoute, isSafePostRoute, isPlanLimit, parseRetryAfter, SutramXApiError, SutramXClient } from '../src/client.js';
import { USER_AGENT } from '../src/constants.js';

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; }
type Handler = (req: http.IncomingMessage, res: http.ServerResponse, index: number) => void;

const servers: http.Server[] = [];
afterEach(() => {
    for (const server of servers.splice(0)) server.close();
    for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy']) delete process.env[name];
});

async function serve(handler: Handler): Promise<{ url: string; seen: Seen[]; }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
        req.resume();
        req.on('end', () => {
            seen.push({ method: req.method!, url: req.url!, headers: req.headers });
            handler(req, res, seen.length - 1);
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
}

function client(url: string, options: ConstructorParameters<typeof SutramXClient>[3] = {}): SutramXClient {
    const api = new SutramXClient('sk_test', url, {}, options);
    api.retryDelay = () => 0;
    return api;
}

test('M1: POSTs carry an Idempotency-Key that the retry reuses (503 then 201); X-SutramX-Client is sent', async () => {
    const { url, seen } = await serve((_req, res, index) => (index === 0 ? json(res, 503, { error: 'busy' }) : json(res, 201, { id: 'm1' })));
    const api = client(url);
    assert.deepEqual(await api.post('/monitors', { name: 'x' }), { id: 'm1' });
    assert.equal(seen.length, 2);
    assert.match(String(seen[0].headers['idempotency-key']), /^[0-9a-f-]{36}$/);
    assert.equal(seen[1].headers['idempotency-key'], seen[0].headers['idempotency-key']);
    assert.equal(seen[0].headers['x-sutramx-client'], USER_AGENT);
    assert.equal(seen[0].headers['user-agent'], USER_AGENT);
    await api.post('/monitors', { name: 'y' });
    assert.notEqual(seen[2].headers['idempotency-key'], seen[0].headers['idempotency-key']);
    await api.get('/monitors');
    assert.equal(seen[3].headers['idempotency-key'], undefined);
});

test('M1: a POST whose connection dropped is retried once with the same key; PATCH is not retried', async () => {
    const { url, seen } = await serve((req, res, index) => {
        if (index === 0 || req.method === 'PATCH') return req.socket.destroy();
        json(res, 201, { ok: true });
    });
    const api = client(url);
    assert.deepEqual(await api.post('/monitors', {}), { ok: true });
    assert.equal(seen[0].headers['idempotency-key'], seen[1].headers['idempotency-key']);
    await assert.rejects(api.patch('/status/pages/1', {}), (error: unknown) => error instanceof SutramXApiError && error.status === 0);
    assert.equal(seen.filter((entry) => entry.method === 'PATCH').length, 1);
});

test('M1: 409 IDEMPOTENCY_REQUEST_IN_PROGRESS waits and asks again with the same key', async () => {
    const retryAfters: Array<string | null> = [];
    const { url, seen } = await serve((_req, res, index) => {
        if (index === 0) return json(res, 409, { error: 'still running', code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' }, { 'Retry-After': '1' });
        json(res, 201, { id: 'm1' }, { 'Idempotent-Replayed': 'true' });
    });
    const api = client(url);
    api.retryDelay = (_attempt, retryAfter) => { retryAfters.push(retryAfter); return 0; };
    assert.deepEqual(await api.post('/monitors', {}), { id: 'm1' });
    assert.equal(seen.length, 2);
    assert.equal(seen[1].headers['idempotency-key'], seen[0].headers['idempotency-key']);
    assert.deepEqual(retryAfters, ['1']);
});

test('only the POST routes the API dedupes (and the read-only plan) are retried; acknowledge, resolve, run-check, pause, resume are sent once, except after a 429', async () => {
    for (const path of ['/monitors', '/v1/monitors', '/monitors/', '/monitors?x=1', '/monitors/bulk', '/monitors/detect/apply', '/monitor-groups', '/status/pages',
        '/status/pages/p1/monitors', '/integrations/slack/connections', '/integrations/slack/connect', '/incidents', '/incidents/runbooks',
        '/incidents/i1/notes', '/maintenance', '/automation/monitors/apply', '/api/v1/maintenance']) {
        assert.ok(isIdempotentPostRoute(path), path);
    }
    for (const path of ['/incidents/i1/acknowledge', '/incidents/i1/resolve', '/monitors/m1/run-check', '/monitors/m1/pause', '/monitors/m1/resume',
        '/integrations/slack/connections/c1/test', '/monitors/m1/heartbeat/rotate-secret', '/automation/monitors/plan', '/monitors/m1', '/ai']) {
        assert.ok(!isIdempotentPostRoute(path), path);
    }

    const unavailable = await serve((_req, res) => json(res, 503, { error: 'busy' }));
    for (const path of ['/incidents/i1/acknowledge', '/incidents/i1/resolve', '/monitors/m1/run-check', '/monitors/m1/pause', '/monitors/m1/resume']) {
        await assert.rejects(client(unavailable.url).post(path, {}), (error: unknown) => error instanceof SutramXApiError && error.status === 503);
    }
    assert.equal(unavailable.seen.length, 5, 'each action attempted once');

    // 429 is retried for an action too (the rate limiter answered before the handler ran).
    const limited = await serve((_req, res, index) => {
        if (index === 0) return json(res, 429, { error: 'slow down' }, { 'Retry-After': '0' });
        json(res, 200, { ok: true });
    });
    assert.deepEqual(await client(limited.url).post('/monitors/m1/run-check', {}), { ok: true });
    assert.equal(limited.seen.length, 2);

    // The read-only plan POST is retried on 503 like a read; it is not a deduped create.
    assert.ok(isSafePostRoute('/automation/monitors/plan') && isSafePostRoute('/v1/automation/monitors/plan/'));
    assert.ok(!isSafePostRoute('/automation/monitors/apply') && !isSafePostRoute('/incidents/i1/resolve'));
    const planning = await serve((_req, res, index) => {
        if (index === 0) return json(res, 503, { error: 'busy' });
        json(res, 200, { monitors: [] });
    });
    assert.deepEqual(await client(planning.url).post('/automation/monitors/plan', {}), { monitors: [] });
    assert.equal(planning.seen.length, 2);
    // A dropped connection: the action is not repeated.
    const dropped = await serve((req) => req.socket.destroy());
    await assert.rejects(client(dropped.url).post('/incidents/i1/acknowledge', {}), (error: unknown) => error instanceof SutramXApiError && error.status === 0);
    assert.equal(dropped.seen.length, 1);

    // A base URL with a path prefix: the route is matched after it, and the retry reuses the key.
    const prefixed = await serve((_req, res, index) => (index === 0 ? json(res, 503, { error: 'busy' }) : json(res, 201, { id: 'p1' })));
    assert.deepEqual(await client(`${prefixed.url}/api/v1`).post('/status/pages', {}), { id: 'p1' });
    assert.equal(prefixed.seen.length, 2);
    assert.equal(prefixed.seen[0].url, '/api/v1/status/pages');
    assert.equal(prefixed.seen[1].headers['idempotency-key'], prefixed.seen[0].headers['idempotency-key']);
});

test('409 IDEMPOTENT_RESPONSE_WITHHELD is an error, not retried; IN_PROGRESS on a route the API does not dedupe is not waited on', async () => {
    const withheld = await serve((_req, res) => json(res, 409, { error: 'The original response held a secret', code: 'IDEMPOTENT_RESPONSE_WITHHELD' }));
    await assert.rejects(client(withheld.url).post('/monitors', {}), (error: unknown) => error instanceof SutramXApiError && error.code === 'IDEMPOTENT_RESPONSE_WITHHELD');
    assert.equal(withheld.seen.length, 1);
    const inProgress = await serve((_req, res) => json(res, 409, { error: 'running', code: 'IDEMPOTENCY_REQUEST_IN_PROGRESS' }, { 'Retry-After': '1' }));
    await assert.rejects(client(inProgress.url).post('/incidents/i1/resolve', {}), (error: unknown) => error instanceof SutramXApiError && error.status === 409);
    assert.equal(inProgress.seen.length, 1);
});

test('GETs are retried once on 5xx, 429 and network errors (Retry-After honoured), then the error is returned', async () => {
    const delays: Array<string | null> = [];
    const flaky = await serve((_req, res, index) => (index === 0 ? json(res, 429, { error: 'slow', code: 'RATE_LIMITED' }, { 'Retry-After': '2' }) : json(res, 200, [])));
    const api = client(flaky.url);
    api.retryDelay = (_attempt, retryAfter) => { delays.push(retryAfter); return 0; };
    assert.deepEqual(await api.get('/monitors'), []);
    assert.deepEqual(delays, ['2']);

    const down = await serve((_req, res) => json(res, 502, { error: 'bad gateway' }));
    await assert.rejects(client(down.url).get('/monitors'), (error: unknown) => error instanceof SutramXApiError && error.status === 502);
    assert.equal(down.seen.length, 2, 'exactly one retry');

    // A Retry-After longer than the agent should wait is returned, not slept through.
    const long = await serve((_req, res) => {
        res.writeHead(429, { 'Content-Type': 'text/plain', 'Retry-After': '600' });
        res.end('Too many requests, please try again later.');
    });
    const slow = new SutramXClient('sk_test', long.url);
    const error = await slow.get('/monitors').catch((caught: SutramXApiError) => caught);
    assert.equal(long.seen.length, 1);
    assert.equal(error.code, 'RATE_LIMITED');
    assert.equal(error.message, 'Too many requests, please try again later.');
    assert.match(describeApiError(error), /wait 600s/);
});

test('Retry-After parses delta-seconds and HTTP-dates', () => {
    const now = Date.parse('2026-10-12T10:00:00Z');
    assert.equal(parseRetryAfter('3', now), 3000);
    assert.equal(parseRetryAfter('Mon, 12 Oct 2026 10:00:04 GMT', now), 4000);
    assert.equal(parseRetryAfter('Mon, 12 Oct 2026 09:00:00 GMT', now), 0);
    assert.equal(parseRetryAfter('later', now), null);
});

test('a 2xx body that is not JSON is an error, not silently returned', async () => {
    const { url } = await serve((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html>Sign in to the network</html>');
    });
    const error = await client(url).get('/monitors').catch((caught: SutramXApiError) => caught);
    assert.ok(error instanceof SutramXApiError);
    assert.equal(error.code, 'INVALID_RESPONSE');
    assert.match(describeApiError(error), /Expected JSON .* text\/html/);
});

/** A CONNECT proxy (what undici's proxy agent speaks) that records the targets it tunnels to. */
async function connectProxy(): Promise<{ url: string; targets: string[]; }> {
    const targets: string[] = [];
    const server = http.createServer((_req, res) => { res.writeHead(405); res.end(); });
    server.on('connect', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        targets.push(req.url!);
        const [host, port] = req.url!.split(':');
        const upstream = connect(Number(port), host, () => {
            socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            upstream.write(head);
            upstream.pipe(socket);
            socket.pipe(upstream);
        });
        upstream.on('error', () => socket.destroy());
        socket.on('error', () => upstream.destroy());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, targets };
}

test('HTTPS_PROXY / HTTP_PROXY route API calls through the proxy; NO_PROXY bypasses it; relay headers still go out', async () => {
    const api = await serve((_req, res) => json(res, 200, { ok: true }));
    const proxy = await connectProxy();
    process.env.HTTP_PROXY = proxy.url;
    const relayed = client(api.url, { relayHeaders: { 'X-SutramX-Client-Ip': '203.0.113.9' } });
    assert.deepEqual(await relayed.get('/monitors'), { ok: true });
    assert.deepEqual(proxy.targets, [api.url.replace('http://', '')]);
    assert.equal(api.seen[0].headers['x-sutramx-client-ip'], '203.0.113.9');
    assert.equal(api.seen[0].headers.authorization, 'Bearer sk_test');
    process.env.NO_PROXY = '127.0.0.1';
    assert.deepEqual(await client(api.url).get('/monitors'), { ok: true });
    assert.equal(proxy.targets.length, 1);
});

test('network errors carry the cause code and host instead of HTTP 0', async () => {
    const probe = http.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const refused = await client(`http://127.0.0.1:${port}`).get('/monitors').catch((caught: SutramXApiError) => caught);
    assert.equal(refused.causeCode, 'ECONNREFUSED');
    const text = describeApiError(refused);
    assert.match(text, new RegExp(`127\\.0\\.0\\.1:${port} \\(ECONNREFUSED\\)`));
    assert.doesNotMatch(text, /HTTP 0/);

    const realFetch = globalThis.fetch;
    let calls = 0;
    try {
        globalThis.fetch = (async () => {
            calls += 1;
            throw new TypeError('fetch failed', { cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' }) });
        }) as typeof fetch;
        const tls = await client('https://api.sutramx.com').get('/monitors').catch((caught: SutramXApiError) => caught);
        assert.equal(calls, 1, 'TLS failures are not retried');
        assert.match(describeApiError(tls), /api\.sutramx\.com \(CERT_HAS_EXPIRED\)/);
        assert.match(describeApiError(tls), /do not retry/);
    } finally {
        globalThis.fetch = realFetch;
    }
});

test('every plan-limit code and category PLAN_LIMIT get the "higher plan, do not retry" hint; a 429 plan limit is not retried', async () => {
    for (const code of ['ENTITLEMENT_LIMIT_REACHED', 'ENTITLEMENT_INTERVAL_TOO_SHORT', 'MONITOR_TOTAL_LIMIT_REACHED', 'CONNECTION_LIMIT_REACHED', 'LIMIT_REACHED', 'AI_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE']) {
        const error = new SutramXApiError(403, 'Limit', code);
        assert.ok(isPlanLimit(error), code);
        assert.match(describeApiError(error), /higher plan.*rather than retrying/, code);
    }
    const { url, seen } = await serve((req, res) => {
        if (req.url === '/ai') return json(res, 429, { error: 'All AI drafts used', code: 'AI_LIMIT_REACHED' });
        json(res, 403, { error: 'Upgrade', code: 'SOMETHING_NEW', category: 'PLAN_LIMIT', details: { resource: 'monitors' } });
    });
    const api = client(url);
    const ai = await api.post('/ai', {}).catch((caught: SutramXApiError) => caught);
    assert.equal(seen.length, 1);
    assert.match(describeApiError(ai), /higher plan/);
    const categorised = await api.post('/monitors', {}).catch((caught: SutramXApiError) => caught);
    assert.ok(isPlanLimit(categorised));
    assert.match(describeApiError(categorised), /higher plan/);
});

test('hosted mode: a 401 still reports the auth failure (after no retry)', async () => {
    let failures = 0;
    const { url, seen } = await serve((_req, res) => json(res, 401, { error: 'Invalid token', code: 'OAUTH_INVALID_TOKEN' }));
    const api = client(url, { onAuthFailure: () => { failures += 1; } });
    await assert.rejects(api.get('/monitors'), (error: unknown) => error instanceof SutramXApiError && error.status === 401);
    assert.equal(failures, 1);
    assert.equal(seen.length, 1);
});
