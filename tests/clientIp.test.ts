import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHmac } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { validateInternalApiUrl } from '../src/client.js';
import { clientIpHeaders, failedAuthLimitFromEnv, FailedAuthLimiter, isPrivateAddress, normaliseIp, trustProxyHops } from '../src/clientIp.js';

/**
 * Failed credentials are limited per client address (not per server), and
 * the address reaches the API with an HMAC proof, so junk tokens from one
 * client can't lock every hosted user out of the API.
 */

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const SECRET = 'proof-0123456789abcdef';
const RESOURCE = 'https://api.example.test/mcp';

test('FailedAuthLimiter: blocks an address after the limit, per address, until the window ends', () => {
    const limiter = new FailedAuthLimiter(3, 60_000);
    const t = 1_000_000;
    for (let i = 0; i < 2; i++) limiter.recordFailure('203.0.113.5', t);
    assert.equal(limiter.retryAfter('203.0.113.5', t), 0, 'below the limit');
    limiter.recordFailure('203.0.113.5', t);
    assert.equal(limiter.retryAfter('203.0.113.5', t + 1000), 59);
    assert.equal(limiter.retryAfter('203.0.113.6', t), 0, 'other addresses are not affected');
    assert.equal(limiter.retryAfter('203.0.113.5', t + 60_000), 0, 'the window ends');
    limiter.recordFailure('203.0.113.5', t + 60_000);
    assert.equal(limiter.retryAfter('203.0.113.5', t + 60_000), 0, 'a new window starts at one');
});

test('FailedAuthLimiter: IPv6 is limited per /64, and the map is bounded', () => {
    const limiter = new FailedAuthLimiter(2, 60_000, 100);
    limiter.recordFailure('2001:db8:1:2::1', 0);
    limiter.recordFailure('2001:0db8:0001:0002:ffff::9', 0);
    assert.ok(limiter.retryAfter('2001:db8:1:2::abcd', 1) > 0);
    assert.equal(limiter.retryAfter('2001:db8:1:3::1', 1), 0);
    for (let i = 0; i < 1000; i++) limiter.recordFailure(`198.51.${Math.floor(i / 256)}.${i % 256}`, 0);
    assert.ok(limiter.size <= 100);
});

test('helpers: trusted proxy hops, limit from env, address parsing, proof headers, internal URL', () => {
    assert.equal(trustProxyHops(env({})), 0);
    assert.equal(trustProxyHops(env({ TRUST_PROXY_HOPS: '1' })), 1);
    assert.equal(trustProxyHops(env({ TRUST_PROXY_HOPS: 'yes' })), 0);
    assert.equal(failedAuthLimitFromEnv(env({})), 50);
    assert.equal(failedAuthLimitFromEnv(env({ MCP_FAILED_AUTH_PER_IP: '5' })), 5);
    assert.equal(normaliseIp('::ffff:203.0.113.5'), '203.0.113.5');
    assert.equal(normaliseIp('not-an-ip'), null);
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.18.0.4', '192.168.1.1', '::1', 'fd00::1']) assert.equal(isPrivateAddress(ip), true, ip);
    for (const ip of ['203.0.113.5', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateAddress(ip), false, ip);
    assert.deepEqual(clientIpHeaders('203.0.113.5', null), {}, 'never without the secret');
    assert.deepEqual(clientIpHeaders(null, SECRET), {});
    assert.deepEqual(clientIpHeaders('203.0.113.5', SECRET), {
        'X-SutramX-Client-Ip': '203.0.113.5',
        'X-SutramX-Client-Ip-Proof': createHmac('sha256', SECRET).update('client-ip:203.0.113.5').digest('hex'),
    });
    assert.equal(validateInternalApiUrl('http://api:3003/'), 'http://api:3003');
    assert.equal(validateInternalApiUrl('http://10.0.0.5:3003'), 'http://10.0.0.5:3003');
    assert.equal(validateInternalApiUrl('https://api.sutramx.com'), 'https://api.sutramx.com');
    assert.throws(() => validateInternalApiUrl('http://api.sutramx.com'), /must use https/);
    assert.throws(() => validateInternalApiUrl('http://8.8.8.8'), /must use https/);
    assert.throws(() => validateInternalApiUrl('http://user:pw@api:3003'), /credentials/);
});

const apiCalls: Array<{ url: string; auth?: string; ip?: string; ipProof?: string; proof?: string; }> = [];
let api: http.Server;
let mcp: ChildProcess;
let mcpUrl = '';

before(async () => {
    api = http.createServer((req, res) => {
        apiCalls.push({
            url: req.url!,
            auth: req.headers.authorization,
            ip: req.headers['x-sutramx-client-ip'] as string | undefined,
            ipProof: req.headers['x-sutramx-client-ip-proof'] as string | undefined,
            proof: req.headers['x-sutramx-resource-proof'] as string | undefined,
        });
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (req.url === '/oauth/token-info') {
            return token === 'sxo_at_good'
                ? send(200, { active: true, aud: RESOURCE, scope: 'monitors:read', read_only: true, workspace_id: 'w1', exp: 4_000_000_000 })
                : send(401, { error: 'invalid', code: 'OAUTH_INVALID_TOKEN' });
        }
        if (req.url?.startsWith('/monitors') && (token === 'sxo_at_good' || token === 'sk_good')) return send(200, []);
        send(401, { error: 'Invalid token' });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    const port = 20000 + Math.floor(Math.random() * 20000);
    mcp = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http'], {
        env: {
            ...process.env, HOST: '127.0.0.1', PORT: String(port), SUTRAMX_API_KEY: '',
            // Public URL for metadata; the calls go to the internal one.
            SUTRAMX_API_URL: 'https://api.example.test',
            SUTRAMX_API_INTERNAL_URL: `http://127.0.0.1:${(api.address() as AddressInfo).port}`,
            MCP_RESOURCE_URL: RESOURCE, OAUTH_RESOURCE_PROXY_SECRET: SECRET, MCP_OAUTH: '',
            TRUST_PROXY_HOPS: '1', MCP_FAILED_AUTH_PER_IP: '3',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('MCP server did not start')), 20000);
        mcp.stderr!.on('data', (chunk) => {
            if (String(chunk).includes('listening on')) {
                clearTimeout(timer);
                resolve();
            }
        });
        mcp.once('exit', (code) => reject(new Error(`MCP server exited ${code}`)));
    });
    mcpUrl = `http://127.0.0.1:${port}`;
});

after(() => {
    mcp?.kill();
    api?.close();
});

function post(ip: string, authorization?: string) {
    return fetch(`${mcpUrl}/mcp`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'X-Forwarded-For': ip,
            ...(authorization ? { Authorization: authorization } : {}),
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
}

async function connect(token: string, ip: string) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), {
        requestInit: { headers: { Authorization: `Bearer ${token}`, 'X-Forwarded-For': ip } },
    }));
    return client;
}

test('junk tokens from one address get 429 + Retry-After without reaching the API; other users are unaffected', async () => {
    apiCalls.length = 0;
    for (let i = 0; i < 3; i++) {
        const response = await post('203.0.113.5', `Bearer sxo_at_junk${i}`);
        assert.equal(response.status, 401);
    }
    const blocked = await post('203.0.113.5', 'Bearer sxo_at_junk9');
    assert.equal(blocked.status, 429);
    assert.ok(Number(blocked.headers.get('retry-after')) > 0);
    assert.equal((await post('203.0.113.5', 'Bearer sxo_at_good')).status, 429, 'blocked before any token check');
    assert.equal(apiCalls.filter((c) => c.url === '/oauth/token-info').length, 3, 'blocked requests never reach the API');
    assert.ok(apiCalls.every((c) => c.ip === '203.0.113.5'));

    const client = await connect('sxo_at_good', '198.51.100.7');
    const result: any = await client.callTool({ name: 'sutramx_list_monitors', arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    await client.close();
});

test('the API gets the end user address with an HMAC proof, through the internal URL', async () => {
    apiCalls.length = 0;
    const client = await connect('sk_good', '198.51.100.8');
    await client.callTool({ name: 'sutramx_list_monitors', arguments: {} });
    await client.close();
    const call = apiCalls.find((c) => c.url.startsWith('/monitors'));
    assert.equal(call?.ip, '198.51.100.8');
    assert.equal(call?.ipProof, createHmac('sha256', SECRET).update('client-ip:198.51.100.8').digest('hex'));
    assert.equal(call?.proof, undefined, 'the resource proof itself still never goes out with API keys');
});

test('a peer on the private network (a proxy without TRUST_PROXY_HOPS) is never locked out', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post('10.0.0.9', 'Bearer sxo_at_junk')).status, 401);
});

test('malformed credentials and API keys the API rejects count too; no credential at all does not', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await post('203.0.113.20')).status, 401, 'the OAuth discovery 401 is not a failure');
    for (let i = 0; i < 3; i++) assert.equal((await post('203.0.113.21', 'Bearer not-a-token')).status, 401);
    assert.equal((await post('203.0.113.21', 'Bearer sk_good')).status, 429);

    for (let i = 0; i < 3; i++) {
        const client = await connect('sk_bad', '203.0.113.22');
        const result: any = await client.callTool({ name: 'sutramx_list_monitors', arguments: {} });
        assert.equal(result.isError, true);
        await client.close();
    }
    assert.equal((await post('203.0.113.22', 'Bearer sk_good')).status, 429);
});
