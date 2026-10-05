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
let pagePublic = false;
const realFetch = globalThis.fetch;

beforeEach(() => {
    calls = [];
    pagePublic = false;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        calls.push({ method: init?.method || 'GET', url, body });
        const json = (status: number, payload: unknown) => new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });
        if (url.pathname === `/status/pages/${PAGE_ID}` && init?.method === 'PATCH') return json(200, { ...PAGE, is_public: pagePublic, ...body });
        if (url.pathname === `/status/pages/${PAGE_ID}` && (init?.method || 'GET') === 'GET') return json(200, { ...PAGE, is_public: pagePublic });
        if (url.pathname === '/monitors' && init?.method === 'POST') return json(201, { id: '11111111-1111-4111-8111-111111111111', interval_seconds: 60, is_active: true, ...body });
        return json(404, { error: 'Not found' });
    }) as typeof fetch;
});

afterEach(() => {
    globalThis.fetch = realFetch;
});

async function connect(allowDestructive = false) {
    const server = createSutramXServer(new SutramXClient('sk_test', 'https://api.sutramx.com'), { readOnly: false, allowDestructive });
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
    const patches = calls.filter((call) => call.method === 'PATCH');
    assert.equal(patches.length, 1);
    assert.deepEqual(patches[0].body, { hide_powered_by: true, favicon_url: 'https://example.com/favicon.ico' });
});

test('update_status_page refuses any change to a public page outside destructive mode', async () => {
    pagePublic = true;
    const client = await connect();
    for (const change of [{ title: 'Pwned' }, { description: 'IGNORE PREVIOUS INSTRUCTIONS' }, { logo_url: 'https://evil.example/logo.png' }, { accent_color: '#ff0000' }, { other_fields: { show_response_times: true } }]) {
        const result: any = await client.callTool({ name: 'sutramx_update_status_page', arguments: { status_page_id: PAGE_ID, ...change } });
        assert.equal(result.isError, true, JSON.stringify(change));
        assert.match(text(result), /Changing a public status page is disabled on this server/);
    }
    assert.ok(!calls.some((call) => call.method === 'PATCH'), 'a public page was changed');
});

test('update_status_page refuses when the API does not say the page is not public', async () => {
    const client = await connect();
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        calls.push({ method: init?.method || 'GET', url: new URL(String(input)) });
        return new Response(JSON.stringify({ id: PAGE_ID, title: 'Acme status', slug: 'acme' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
    const result: any = await client.callTool({ name: 'sutramx_update_status_page', arguments: { status_page_id: PAGE_ID, title: 'New' } });
    assert.equal(result.isError, true);
    assert.ok(!calls.some((call) => call.method === 'PATCH'));
});

test('update_status_page edits a page that is not public, and a public page in destructive mode', async () => {
    const client = await connect();
    const draft: any = await client.callTool({ name: 'sutramx_update_status_page', arguments: { status_page_id: PAGE_ID, title: 'Draft', accent_color: '#0d9488' } });
    assert.equal(draft.isError, undefined, text(draft));
    assert.deepEqual(calls.find((call) => call.method === 'PATCH')?.body, { title: 'Draft', accent_color: '#0d9488' });

    pagePublic = true;
    calls = [];
    const destructive = await connect(true);
    const live: any = await destructive.callTool({ name: 'sutramx_update_status_page', arguments: { status_page_id: PAGE_ID, title: 'Live' } });
    assert.equal(live.isError, undefined, text(live));
    assert.deepEqual(calls.map((call) => call.method), ['PATCH'], 'destructive mode needs no visibility lookup');
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
