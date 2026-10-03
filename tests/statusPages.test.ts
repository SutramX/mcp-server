import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SutramXClient } from '../src/client.js';
import { createSutramXServer } from '../src/server.js';
import { MONITOR_TYPES } from '../src/tools/monitors.js';
import { STATUS_PAGE_SETTINGS, statusPagePatch } from '../src/tools/statusPages.js';

const PAGE_ID = '55555555-5555-4555-8555-555555555555';
const PAGE = { id: PAGE_ID, title: 'Acme status', slug: 'acme', is_public: true, monitor_count: 2 };

let calls: Array<{ method: string; url: URL; body?: any; }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    calls = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method || 'GET', url, body });
        const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname === `/status/pages/${PAGE_ID}` && init?.method === 'PATCH') return json(200, { ...PAGE, ...body });
        if (url.pathname === '/monitors' && init?.method === 'POST') return json(201, { id: '11111111-1111-4111-8111-111111111111', interval_seconds: 60, is_active: true, ...body });
        return json(404, { error: 'Not found' });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

async function connect() {
    const server = createSutramXServer(new SutramXClient('sk_test', 'https://api.sutramx.com'), { readOnly: false, allowDestructive: false });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
}

const text = (result: any): string => result.content.map((part: any) => part.text).join('\n');

test('the accepted status page settings match the API (UpdateStatusPageSchema is strict)', () => {
    assert.deepEqual([...STATUS_PAGE_SETTINGS].sort(), [
        'accent_color', 'description', 'favicon_url', 'hide_powered_by', 'is_public', 'logo_url', 'show_response_times', 'slug', 'title',
    ]);
});

test('statusPagePatch: named fields win, known other_fields pass, unknown keys are refused', () => {
    assert.deepEqual(statusPagePatch({ title: 'New', is_public: undefined }, { title: 'Old', show_response_times: true }), { title: 'New', show_response_times: true });
    assert.throws(() => statusPagePatch({ title: 'New' }, { custom_domain: 'status.example.com' }), /Unknown status page setting: "custom_domain"\. The API accepts only: title, description, slug/);
    assert.throws(() => statusPagePatch({}, { foo: 1, bar: 2 }), /Unknown status page settings: "foo", "bar"/);
    assert.throws(() => statusPagePatch({}, JSON.parse('{"__proto__": {"x": 1}}')), /Unknown status page setting: "__proto__"/);
    assert.throws(() => statusPagePatch({}, { accent_color: 'red' }), /accent_color: hex colour/);
    assert.throws(() => statusPagePatch({}, { logo_url: 'http://example.com/logo.png' }), /logo_url: must be an https:\/\/ URL/);
    assert.throws(() => statusPagePatch({}, {}), /at least one field/);
});

test('update_status_page refuses unknown keys without calling the API', async () => {
    const client = await connect();
    const result: any = await client.callTool({ name: 'sutramx_update_status_page', arguments: { status_page_id: PAGE_ID, title: 'Acme', other_fields: { theme: 'dark' } } });
    assert.equal(result.isError, true);
    assert.match(text(result), /Unknown status page setting: "theme"/);
    assert.match(text(result), /show_response_times/);
    assert.equal(calls.length, 0);
});

test('update_status_page sends only accepted keys, including favicon_url and other_fields', async () => {
    const client = await connect();
    const result: any = await client.callTool({
        name: 'sutramx_update_status_page',
        arguments: { status_page_id: PAGE_ID, favicon_url: 'https://example.com/favicon.ico', other_fields: { hide_powered_by: true } },
    });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, 'PATCH');
    assert.deepEqual(calls[0].body, { hide_powered_by: true, favicon_url: 'https://example.com/favicon.ico' });
});

test('update_status_page description lists the accepted settings and no longer promises pass-through', async () => {
    const { tools } = await (await connect()).listTools();
    const tool = tools.find((item) => item.name === 'sutramx_update_status_page')!;
    for (const name of STATUS_PAGE_SETTINGS) assert.ok(tool.description!.includes(name), `description misses ${name}`);
    assert.ok(!/passed through|any newer/i.test(JSON.stringify(tool)), 'still promises arbitrary pass-through');
    assert.ok((tool.inputSchema.properties as Record<string, unknown>).favicon_url, 'favicon_url is a named field');
});

test('create_monitor documents every monitor type the API accepts, including dns and multistep', async () => {
    assert.deepEqual([...MONITOR_TYPES].sort(), ['api', 'cron', 'dns', 'http', 'multistep', 'ping', 'port', 'udp']);
    const client = await connect();
    const { tools } = await client.listTools();
    const tool = tools.find((item) => item.name === 'sutramx_create_monitor')!;
    const typeDescription = (tool.inputSchema.properties as Record<string, any>).type.description as string;
    for (const type of MONITOR_TYPES) assert.match(typeDescription, new RegExp(`\\b${type}\\b`));
    const configDescription = (tool.inputSchema.properties as Record<string, any>).config.description as string;
    assert.match(configDescription, /dns monitors \{"hostname"/);
    assert.match(configDescription, /multistep monitors \{"steps"/);

    const result: any = await client.callTool({ name: 'sutramx_create_monitor', arguments: { name: 'MX', type: 'dns', config: { hostname: 'example.com', record_type: 'MX' } } });
    assert.equal(result.isError, undefined, text(result));
    assert.equal(calls[0].body.type, 'dns');
});
