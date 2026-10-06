import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { oauthEnabled, oauthStartupProblem } from '../src/oauth.js';

/**
 * HTTP mode in production never forwards OAuth tokens without the resource
 * proof: a missing or short OAUTH_RESOURCE_PROXY_SECRET stops the server at
 * startup instead of silently dropping the proof.
 */

const env = (values: Record<string, string>) => values as unknown as NodeJS.ProcessEnv;
const SECRET = 'proof-0123456789abcdef';

test('oauthStartupProblem: production needs a proof secret of at least 16 characters', () => {
    assert.match(oauthStartupProblem(env({ NODE_ENV: 'production' }))!, /OAUTH_RESOURCE_PROXY_SECRET is not set/);
    assert.match(oauthStartupProblem(env({ NODE_ENV: 'production', OAUTH_RESOURCE_PROXY_SECRET: '   ' }))!, /is not set/);
    assert.match(oauthStartupProblem(env({ NODE_ENV: 'production', OAUTH_RESOURCE_PROXY_SECRET: 'short-secret' }))!, /shorter than 16 characters/);
    assert.equal(oauthStartupProblem(env({ NODE_ENV: 'production', OAUTH_RESOURCE_PROXY_SECRET: SECRET })), null);
    assert.equal(oauthStartupProblem(env({ NODE_ENV: 'production', MCP_OAUTH: 'off' })), null, 'API-key-only servers need no proof');
    assert.equal(oauthStartupProblem(env({})), null, 'local development is unaffected');
    assert.equal(oauthStartupProblem(env({ NODE_ENV: 'development', OAUTH_RESOURCE_PROXY_SECRET: 'short' })), null);
    assert.equal(oauthEnabled(env({})), true);
    assert.equal(oauthEnabled(env({ MCP_OAUTH: 'OFF' })), false);
    assert.equal(oauthEnabled(env({ MCP_OAUTH: 'on' })), true);
});

type Started = { started: boolean; code: number | null; stderr: string; url: string; stop: () => void; };

function startHttp(extra: Record<string, string>, keep = false): Promise<Started> {
    const port = 20000 + Math.floor(Math.random() * 20000);
    const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts', '--http'], {
        env: {
            ...process.env, HOST: '127.0.0.1', PORT: String(port), SUTRAMX_API_KEY: '',
            OAUTH_RESOURCE_PROXY_SECRET: '', MCP_OAUTH: '', ...extra,
        },
        stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const url = `http://127.0.0.1:${port}`;
    const stop = () => child.kill();
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`MCP server neither started nor exited: ${stderr}`));
        }, 20000);
        child.stderr!.on('data', (chunk) => {
            stderr += String(chunk);
            if (stderr.includes('listening on')) {
                clearTimeout(timer);
                if (!keep) child.kill();
                resolve({ started: true, code: null, stderr, url, stop });
            }
        });
        child.once('exit', (code) => {
            clearTimeout(timer);
            resolve({ started: stderr.includes('listening on'), code, stderr, url, stop });
        });
    });
}

test('HTTP mode with NODE_ENV=production refuses to start without the proof secret', async () => {
    const missing = await startHttp({ NODE_ENV: 'production' });
    assert.equal(missing.started, false);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /OAUTH_RESOURCE_PROXY_SECRET is not set/);

    const short = await startHttp({ NODE_ENV: 'production', OAUTH_RESOURCE_PROXY_SECRET: 'too-short' });
    assert.equal(short.started, false);
    assert.match(short.stderr, /shorter than 16 characters/);
});

test('HTTP mode starts in production with the secret, with MCP_OAUTH=off, and outside production', async () => {
    assert.equal((await startHttp({ NODE_ENV: 'production', OAUTH_RESOURCE_PROXY_SECRET: SECRET })).started, true);
    assert.equal((await startHttp({ NODE_ENV: 'production', MCP_OAUTH: 'off' })).started, true);
    const dev = await startHttp({ NODE_ENV: 'development' });
    assert.equal(dev.started, true);
    assert.match(dev.stderr, /Warning: OAUTH_RESOURCE_PROXY_SECRET is not set/);
});

test('MCP_OAUTH=off: no protected-resource metadata, OAuth tokens refused', async () => {
    const server = await startHttp({ NODE_ENV: 'production', MCP_OAUTH: 'off' }, true);
    try {
        assert.equal(server.started, true);
        assert.equal((await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`)).status, 404);
        const response = await fetch(`${server.url}/mcp`, {
            method: 'POST',
            headers: { Authorization: 'Bearer sxo_at_anything', 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
        });
        assert.equal(response.status, 401);
        assert.doesNotMatch(response.headers.get('www-authenticate') || '', /resource_metadata/);
        assert.match(JSON.stringify(await response.json()), /OAuth is disabled/);
    } finally {
        server.stop();
    }
});
