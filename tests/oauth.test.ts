import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
    bearerChallenge,
    bearerCredential,
    checkOAuthToken,
    clearTokenCache,
    oauthResourceConfig,
    resourceMetadataPaths,
    resourceMetadataUrl,
} from '../src/oauth.js';

/**
 * OAuth in HTTP mode, against a fake SutramX API: protected-resource
 * metadata, 401 challenges, token validation (audience, revocation) and
 * scope → tool policy, with the real server process.
 */

const RESOURCE = 'https://api.example.test/mcp';
const TOKENS: Record<string, Record<string, unknown>> = {
    sxo_at_reader: { active: true, aud: RESOURCE, scope: 'monitors:read incidents:read', read_only: true, workspace_id: 'w1', exp: 4_000_000_000 },
    sxo_at_writer: { active: true, aud: RESOURCE, scope: 'monitors:read monitors:write', read_only: false, workspace_id: 'w1', exp: 4_000_000_000 },
    sxo_at_demoted: { active: true, aud: RESOURCE, scope: 'monitors:read monitors:write', read_only: true, workspace_id: 'w1', exp: 4_000_000_000 },
    sxo_at_otheraud: { active: true, aud: 'https://evil.example/mcp', scope: 'monitors:read', exp: 4_000_000_000 },
};
const apiCalls: Array<{ url: string; auth?: string; proof?: string; }> = [];
let api: http.Server;
let apiUrl = '';
let mcp: ChildProcess;
let mcpUrl = '';

before(async () => {
    api = http.createServer((req, res) => {
        apiCalls.push({ url: req.url!, auth: req.headers.authorization, proof: req.headers['x-sutramx-resource-proof'] as string | undefined });
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };
        const token = (req.headers.authorization || '').replace(/^Bearer /, '');
        if (req.url === '/oauth/token-info') {
            const info = TOKENS[token];
            return info ? send(200, info) : send(401, { error: 'invalid', code: 'OAUTH_INVALID_TOKEN' });
        }
        if (req.url?.startsWith('/monitors') && (TOKENS[token] || token === 'sk_test')) return send(200, [{ id: 'm1', name: 'Home', current_status: 'up', type: 'http', url: 'https://example.com' }]);
        send(401, { error: 'Invalid token' });
    });
    await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

    const port = 20000 + Math.floor(Math.random() * 20000);
    mcp = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http'], {
        env: {
            ...process.env, HOST: '127.0.0.1', PORT: String(port), SUTRAMX_API_URL: apiUrl, SUTRAMX_API_KEY: '',
            MCP_RESOURCE_URL: RESOURCE, MCP_AUTHORIZATION_SERVER: 'https://api.example.test', OAUTH_RESOURCE_PROXY_SECRET: 'proof-0123456789abcdef',
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

async function connect(token: string) {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${mcpUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
}

test('helpers: credential parsing, metadata URL (RFC 9728 path insertion), challenge', () => {
    assert.deepEqual(bearerCredential('Bearer sk_abc'), { kind: 'api_key', token: 'sk_abc' });
    assert.deepEqual(bearerCredential('Bearer sxo_at_abc-_1'), { kind: 'oauth', token: 'sxo_at_abc-_1' });
    assert.equal(bearerCredential('Bearer sxo_rt_abc'), null, 'refresh tokens are not bearer credentials');
    assert.equal(bearerCredential('Bearer eyJhbGciOi.x.y'), null);
    assert.equal(bearerCredential('Basic abc'), null);
    assert.equal(resourceMetadataUrl('https://api.sutramx.com/mcp'), 'https://api.sutramx.com/.well-known/oauth-protected-resource/mcp');
    assert.deepEqual(resourceMetadataPaths('https://api.sutramx.com/mcp'), ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']);
    const config = oauthResourceConfig('https://api.sutramx.com', {} as NodeJS.ProcessEnv);
    assert.equal(config.resource, 'https://api.sutramx.com/mcp');
    assert.equal(config.authorizationServer, 'https://api.sutramx.com');
    assert.equal(bearerChallenge(config, { error: 'invalid_token' }),
        'Bearer error="invalid_token", resource_metadata="https://api.sutramx.com/.well-known/oauth-protected-resource/mcp"');
});

test('protected resource metadata is served at both well-known paths, to any origin', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
        const response = await fetch(`${mcpUrl}${path}`, { headers: { Origin: 'https://claude.ai' } });
        assert.equal(response.status, 200, path);
        assert.equal(response.headers.get('access-control-allow-origin'), '*');
        const body = await response.json() as any;
        assert.equal(body.resource, RESOURCE);
        assert.deepEqual(body.authorization_servers, ['https://api.example.test']);
        assert.ok(body.scopes_supported.includes('monitors:write'));
    }
});

test('no or unknown credentials: 401 with WWW-Authenticate resource_metadata', async () => {
    const init = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };
    const none = await fetch(`${mcpUrl}/mcp`, init);
    assert.equal(none.status, 401);
    assert.match(String(none.headers.get('www-authenticate')), /^Bearer resource_metadata="https:\/\/api\.example\.test\/\.well-known\/oauth-protected-resource\/mcp"$/);

    for (const token of ['sxo_at_unknown', 'sxo_at_otheraud']) {
        const response = await fetch(`${mcpUrl}/mcp`, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token}` } });
        assert.equal(response.status, 401, token);
        assert.match(String(response.headers.get('www-authenticate')), /error="invalid_token"/, token);
    }
    const garbage = await fetch(`${mcpUrl}/mcp`, { ...init, headers: { ...init.headers, Authorization: 'Bearer something-else' } });
    assert.equal(garbage.status, 401);
});

test('scopes decide the tools: read-only grant (or a demoted user) gets read tools only', async () => {
    for (const token of ['sxo_at_reader', 'sxo_at_demoted']) {
        const client = await connect(token);
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.ok(names.includes('sutramx_list_monitors'), token);
        assert.ok(!names.includes('sutramx_create_monitor'), token);
        assert.ok(!names.includes('sutramx_pause_monitor'), token);
        await client.close();
    }
    const writer = await connect('sxo_at_writer');
    const names = (await writer.listTools()).tools.map((tool) => tool.name);
    assert.ok(names.includes('sutramx_pause_monitor'));
    assert.ok(!names.includes('sutramx_delete_monitor'), 'deletes stay off unless the client opts in');
    await writer.close();
});

test('the token is passed to the API with the resource proof; API keys still work', async () => {
    apiCalls.length = 0;
    const client = await connect('sxo_at_reader');
    const result: any = await client.callTool({ name: 'sutramx_list_monitors', arguments: {} });
    assert.equal(result.isError, undefined, JSON.stringify(result));
    const call = apiCalls.find((c) => c.url.startsWith('/monitors'));
    assert.equal(call?.auth, 'Bearer sxo_at_reader');
    assert.equal(call?.proof, 'proof-0123456789abcdef');
    await client.close();

    apiCalls.length = 0;
    const keyClient = await connect('sk_test');
    await keyClient.callTool({ name: 'sutramx_list_monitors', arguments: {} });
    assert.ok(!apiCalls.some((c) => c.url === '/oauth/token-info'), 'API keys are not introspected');
    assert.equal(apiCalls.find((c) => c.url.startsWith('/monitors'))?.proof, undefined, 'the proof never goes out with API keys');
    await keyClient.close();
});

test('token checks are cached briefly and fail closed when the API is unreachable', async () => {
    clearTokenCache();
    const config = oauthResourceConfig(apiUrl, { MCP_RESOURCE_URL: RESOURCE } as unknown as NodeJS.ProcessEnv);
    apiCalls.length = 0;
    assert.equal((await checkOAuthToken('sxo_at_reader', apiUrl, config)).ok, true);
    assert.equal((await checkOAuthToken('sxo_at_reader', apiUrl, config)).ok, true);
    assert.equal(apiCalls.filter((c) => c.url === '/oauth/token-info').length, 1);
    const down = await checkOAuthToken('sxo_at_writer', 'http://127.0.0.1:9', config);
    assert.deepEqual(down.ok ? null : down.status, 503);
});
