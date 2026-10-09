import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { bearerKey, isAllowedOrigin, mayUseEnvKey } from '../src/auth.js';
import { describeApiError, parseErrorBody, SutramXClient } from '../src/client.js';
import { createSutramXServer } from '../src/server.js';
import type { ToolPolicy } from '../src/policy.js';

/** A fake SutramX API that records requests. */
const requests: Array<{ method: string; url: string; auth?: string; body?: any; }> = [];
const MONITOR = {
    id: '11111111-1111-4111-8111-111111111111', name: 'Homepage', type: 'http', url: 'https://example.com',
    interval_seconds: 60, is_active: true, config: {}, current_status: 'up', uptime_24h: 99.95, tags: ['prod'],
};
let api: http.Server;
let baseUrl = '';

before(async () => {
    api = http.createServer((req, res) => {
        let raw = '';
        req.on('data', (chunk) => { raw += chunk; });
        req.on('end', () => {
            requests.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
            const send = (status: number, body: unknown) => {
                res.writeHead(status, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(body));
            };
            if (req.headers.authorization !== 'Bearer sk_test' && !req.url!.startsWith('/catalog')) return send(401, { error: 'Invalid API key' });
            if (req.method === 'GET' && req.url === '/monitors') return send(200, [MONITOR, { ...MONITOR, id: '22222222-2222-4222-8222-222222222222', name: 'API', current_status: 'down', url: 'https://api.example.com' }]);
            if (req.method === 'POST' && req.url === `/monitors/${MONITOR.id}/pause`) return send(200, { ...MONITOR, is_active: false });
            if (req.method === 'PUT' && req.url === '/automation/monitors/homepage') return send(201, { action: 'created', monitor: { ...MONITOR, external_id: 'homepage' } });
            if (req.method === 'POST' && req.url === '/incidents/33333333-3333-4333-8333-333333333333/acknowledge') {
                return send(409, { success: false, error: { code: 'INCIDENT_RESOLVED', message: 'Incident is already resolved' } });
            }
            if (req.method === 'GET' && req.url === '/incidents/44444444-4444-4444-8444-444444444444') {
                return send(200, { incident: { id: '44444444-4444-4444-8444-444444444444', monitor_name: 'Homepage', started_at: '2026-10-01T00:00:00Z', resolved_at: null }, events: [] });
            }
            if (req.method === 'GET' && req.url === '/catalog/regions') return send(200, { regions: [{ code: 'bom', name: 'Mumbai', country: 'IN' }], count: 1 });
            send(404, { error: 'Not found' });
        });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
});

after(() => api.close());

async function connect(key = 'sk_test', policy: ToolPolicy = { readOnly: false, allowDestructive: true }) {
    const server = createSutramXServer(new SutramXClient(key, baseUrl), policy);
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

function text(result: any): string {
    return result.content.map((part: any) => part.text).join('\n');
}

test('exposes the monitor, incident, status page and account tools with annotations', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const name of [
        'sutramx_list_monitors', 'sutramx_get_monitor', 'sutramx_create_monitor', 'sutramx_update_monitor', 'sutramx_pause_monitor',
        'sutramx_resume_monitor', 'sutramx_delete_monitor', 'sutramx_get_check_results', 'sutramx_list_incidents',
        'sutramx_acknowledge_incident', 'sutramx_list_status_pages', 'sutramx_create_status_page', 'sutramx_whoami', 'sutramx_list_regions',
    ]) assert.ok(names.includes(name), `missing ${name}`);
    const deleteTool = tools.find((tool) => tool.name === 'sutramx_delete_monitor')!;
    assert.equal(deleteTool.annotations?.destructiveHint, true);
    assert.equal(tools.find((tool) => tool.name === 'sutramx_list_monitors')!.annotations?.readOnlyHint, true);
});

test('list_monitors filters by status client-side and sends the API key', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_list_monitors', arguments: { status: 'down' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.total, 1);
    assert.match(text(result), /API/);
    assert.equal(requests.at(-1)!.auth, 'Bearer sk_test');
});

test('create_monitor with a key is an idempotent upsert', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_create_monitor', arguments: { name: 'Homepage', url: 'https://example.com', key: 'homepage' } });
    assert.equal(result.structuredContent.action, 'created');
    const call = requests.at(-1)!;
    assert.equal(call.method, 'PUT');
    assert.equal(call.body.type, 'http');
    assert.equal(call.body.name, 'Homepage');
});

test('pause_monitor calls the pause endpoint', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_pause_monitor', arguments: { monitor_id: MONITOR.id } });
    assert.match(text(result), /Paused/);
});

test('API errors come back as isError results with a hint', async () => {
    const client = await connect();
    const conflict: any = await client.callTool({ name: 'sutramx_acknowledge_incident', arguments: { incident_id: '33333333-3333-4333-8333-333333333333' } });
    assert.equal(conflict.isError, true);
    assert.match(text(conflict), /HTTP 409 \[INCIDENT_RESOLVED\]\): Incident is already resolved/);

    const unauthorized: any = await (await connect('sk_wrong')).callTool({ name: 'sutramx_list_monitors', arguments: {} });
    assert.equal(unauthorized.isError, true);
    assert.match(text(unauthorized), /API key/);
});

test('list_regions uses the public catalogue without the key', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_list_regions', arguments: {} });
    assert.equal(result.structuredContent.total, 1);
    assert.equal(requests.at(-1)!.auth, undefined);
});

test('parseErrorBody understands every backend error shape', () => {
    assert.deepEqual({ ...parseErrorBody(400, { error: 'Validation failed', errors: [{ field: 'name', message: 'Required' }] }) }, {
        status: 400, code: undefined, details: [{ field: 'name', message: 'Required' }], name: 'SutramXApiError',
    });
    assert.equal(parseErrorBody(400, { error: 'Validation failed', errors: [{ field: 'name', message: 'Required' }] }).message, 'Validation failed: name: Required');
    const nested = parseErrorBody(403, { success: false, error: { code: 'FEATURE_NOT_AVAILABLE', message: 'Upgrade', details: { plan: 'free' } } });
    assert.equal(nested.code, 'FEATURE_NOT_AVAILABLE');
    assert.equal(nested.message, 'Upgrade');
    assert.equal(parseErrorBody(502, 'Bad gateway').message, 'HTTP 502');
});

test('bearerKey accepts only SutramX keys', () => {
    assert.equal(bearerKey('Bearer sk_abc'), 'sk_abc');
    assert.equal(bearerKey('bearer sk_abc'), 'sk_abc');
    assert.equal(bearerKey('Bearer eyJhbGciOi'), null);
    assert.equal(bearerKey(undefined), null);
});

test('isAllowedOrigin: no Origin passes; every browser origin (loopback included) needs MCP_ALLOWED_ORIGINS', () => {
    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin('http://localhost:6274'), false);
    assert.equal(isAllowedOrigin('http://127.0.0.1:3000'), false);
    assert.equal(isAllowedOrigin('http://[::1]:3000'), false);
    assert.equal(isAllowedOrigin('https://evil.example.com'), false);
    assert.equal(isAllowedOrigin('null'), false);
    assert.equal(isAllowedOrigin('null', ['null']), false);
    assert.equal(isAllowedOrigin('http://localhost.evil.example.com'), false);
    assert.equal(isAllowedOrigin('http://localhost:6274', ['http://localhost:6274']), true);
    assert.equal(isAllowedOrigin('http://localhost:6275', ['http://localhost:6274']), false);
    assert.equal(isAllowedOrigin('https://app.example.com', ['https://app.example.com/']), true);
    assert.equal(isAllowedOrigin('https://any.example.com', ['*']), true);
});

test('mayUseEnvKey: the server key is lent only to no-Origin requests and explicitly listed origins', () => {
    assert.equal(mayUseEnvKey(undefined), true);
    assert.equal(mayUseEnvKey('http://localhost:5173'), false);
    assert.equal(mayUseEnvKey('http://localhost:6274', ['http://localhost:6274']), true);
    assert.equal(mayUseEnvKey('https://any.example.com', ['*']), false);
});

test('get_incident unwraps the {incident, ...} response', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_get_incident', arguments: { incident_id: '44444444-4444-4444-8444-444444444444', response_format: 'markdown' } });
    assert.equal(result.isError, undefined);
    assert.match(text(result), /# Incident 44444444-4444-4444-8444-444444444444/);
    assert.match(text(result), /«Homepage»/);
});

test('a read-only key refusal tells the agent not to retry', () => {
    const error = parseErrorBody(403, { error: 'This API key is read-only. Use a standard or automation API key to make changes.', code: 'READ_ONLY_ACCESS' });
    const text = describeApiError(error);
    assert.match(text, /\[READ_ONLY_ACCESS\]/);
    assert.match(text, /read-only/);
    assert.match(text, /do not retry/);
});
