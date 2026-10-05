import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SutramXClient } from '../src/client.js';
import { createSutramXServer } from '../src/server.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

test('README documents every tool, the access modes and nothing internal', async () => {
    const server = createSutramXServer(new SutramXClient('sk_test', 'https://api.sutramx.com'), { readOnly: false, allowDestructive: true });
    const client = new Client({ name: 'test', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    for (const tool of tools) assert.ok(README.includes(`\`${tool.name}\``), `README misses ${tool.name}`);
    for (const word of ['SUTRAMX_READ_ONLY', 'SUTRAMX_ALLOW_DESTRUCTIVE', 'X-SutramX-Read-Only', 'X-SutramX-Allow-Destructive', 'SUTRAMX_HTTP_ALLOW_DESTRUCTIVE_HEADER', 'SUTRAMX_MAX_WRITES_PER_MINUTE', 'OAuth']) assert.ok(README.includes(word), `README misses ${word}`);
    assert.doesNotMatch(README, /\/Users\/|NPM_TOKEN/);
    const addresses = (README.match(/\b\d{1,3}(\.\d{1,3}){3}\b/g) || []).filter((ip) => ip !== '127.0.0.1' && ip !== '0.0.0.0');
    assert.deepEqual(addresses, [], 'README names a server address');
});
