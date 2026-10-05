#!/usr/bin/env node
/**
 * End-to-end check of OAuth for the HTTP MCP server against a running SutramX
 * API (local or staging — never point it at production):
 *
 *   discover (401 → protected-resource metadata → AS metadata) → register →
 *   authorize → approve (as the dashboard consent page would) → token →
 *   MCP tools/list + tools/call → refresh → revoke.
 *
 * Env:
 *   MCP_URL        the MCP endpoint, e.g. http://127.0.0.1:3333/mcp
 *   SESSION_TOKEN  a dashboard session access token (stands in for the user
 *                  clicking "Allow access" on /oauth/consent)
 *   WORKSPACE_ID   the workspace to grant
 *   SCOPES         optional, default "monitors:read incidents:read status_pages:read"
 *
 * Usage: MCP_URL=... SESSION_TOKEN=... WORKSPACE_ID=... node scripts/oauth-e2e.mjs
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const { MCP_URL, SESSION_TOKEN, WORKSPACE_ID } = process.env;
const SCOPES = (process.env.SCOPES || 'monitors:read incidents:read status_pages:read').split(/\s+/).filter(Boolean);
if (!MCP_URL || !SESSION_TOKEN || !WORKSPACE_ID) {
    console.error('Set MCP_URL, SESSION_TOKEN and WORKSPACE_ID');
    process.exit(2);
}
if (/sutramx\.com/i.test(MCP_URL) && !process.env.ALLOW_REMOTE) {
    console.error('Refusing to run against a sutramx.com host (set ALLOW_REMOTE=1 for staging).');
    process.exit(2);
}

let step = 0;
function ok(message) {
    step += 1;
    console.log(`ok ${step} - ${message}`);
}
function fail(message, detail) {
    console.error(`not ok ${step + 1} - ${message}`);
    if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2));
    process.exit(1);
}
async function json(response) {
    const text = await response.text();
    try {
        return text ? JSON.parse(text) : null;
    } catch {
        return text;
    }
}

// 1. Discovery.
const unauth = await fetch(MCP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
});
const challenge = unauth.headers.get('www-authenticate') || '';
const metadataUrl = /resource_metadata="([^"]+)"/.exec(challenge)?.[1];
if (unauth.status !== 401 || !metadataUrl) fail('unauthenticated request returns 401 with resource_metadata', { status: unauth.status, challenge });
ok(`401 challenge → ${metadataUrl}`);

// The advertised URL uses the public origin; locally fetch it from the MCP server itself.
const prmLocal = new URL(new URL(metadataUrl).pathname, MCP_URL).toString();
const prm = await json(await fetch(prmLocal));
const resource = prm?.resource;
const issuer = prm?.authorization_servers?.[0];
if (!resource || !issuer) fail('protected resource metadata names the resource and an authorization server', prm);
ok(`protected resource ${resource}, authorization server ${issuer}`);

const as = await json(await fetch(`${issuer}/.well-known/oauth-authorization-server`));
if (as?.issuer !== issuer || !as.code_challenge_methods_supported?.includes('S256') || !as.registration_endpoint) fail('authorization server metadata', as);
ok('authorization server metadata (issuer matches, S256, registration endpoint)');

// 2. Dynamic client registration.
const redirectUri = 'http://127.0.0.1:53682/callback';
const registration = await fetch(as.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'SutramX OAuth e2e', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], token_endpoint_auth_method: 'none' }),
});
const client = await json(registration);
if (registration.status !== 201 || !client?.client_id) fail('client registration', client);
ok(`registered ${client.client_id}`);

// 3. Authorization request (PKCE S256 + resource).
const verifier = randomBytes(32).toString('base64url');
const state = randomBytes(12).toString('base64url');
const authorizeUrl = new URL(as.authorization_endpoint);
for (const [key, value] of Object.entries({
    response_type: 'code', client_id: client.client_id, redirect_uri: redirectUri, state, resource, scope: SCOPES.join(' '),
    code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
})) authorizeUrl.searchParams.set(key, value);
const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
const consentUrl = new URL(authorize.headers.get('location') || 'about:blank');
const request = consentUrl.searchParams.get('request');
if (authorize.status !== 302 || !request) fail('authorize redirects to the consent page', { status: authorize.status, location: consentUrl.toString() });
ok(`authorize → consent page ${consentUrl.origin}${consentUrl.pathname}`);

// 4. Consent (what the dashboard does when the user clicks "Allow access").
const apiBase = issuer;
const sessionHeaders = { 'Content-Type': 'application/json', Authorization: `Bearer ${SESSION_TOKEN}` };
const details = await json(await fetch(`${apiBase}/oauth/authorize/details`, { method: 'POST', headers: sessionHeaders, body: JSON.stringify({ request }) }));
if (!details?.client?.name) fail('consent details', details);
ok(`consent shows "${details.client.name}" → ${details.redirect_host}, scopes offered: ${details.scopes.map((s) => s.scope).join(', ')}`);
const decision = await json(await fetch(`${apiBase}/oauth/authorize/decision`, {
    method: 'POST', headers: sessionHeaders, body: JSON.stringify({ request, approve: true, workspace_id: WORKSPACE_ID, scopes: SCOPES }),
}));
const callback = new URL(decision?.redirect_to || 'about:blank');
const code = callback.searchParams.get('code');
if (!code || callback.searchParams.get('state') !== state || callback.searchParams.get('iss') !== issuer) fail('approval redirects back with code, state and iss', decision);
ok('approved: code, state and iss returned to the client');

// 5. Token.
async function tokenRequest(params) {
    const response = await fetch(as.token_endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(params) });
    return { status: response.status, body: await json(response) };
}
const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: client.client_id, resource });
if (tokens.status !== 200 || !tokens.body.access_token || !tokens.body.refresh_token) fail('token exchange', tokens);
ok(`token: scope "${tokens.body.scope}", expires_in ${tokens.body.expires_in}s`);

// 6. MCP with the access token.
async function mcpWith(accessToken) {
    const mcp = new Client({ name: 'oauth-e2e', version: '1.0.0' });
    await mcp.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { Authorization: `Bearer ${accessToken}` } } }));
    return mcp;
}
const mcp = await mcpWith(tokens.body.access_token);
const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
if (!tools.includes('sutramx_list_monitors')) fail('tools/list', tools);
ok(`tools/list: ${tools.length} tools (${tools.some((t) => t === 'sutramx_create_monitor') ? 'read-write' : 'read-only'})`);
const whoami = await mcp.callTool({ name: 'sutramx_whoami', arguments: {} });
if (whoami.isError) fail('sutramx_whoami', whoami);
ok(`sutramx_whoami: ${whoami.content[0].text.slice(0, 120).replace(/\s+/g, ' ')}…`);
const monitors = await mcp.callTool({ name: 'sutramx_list_monitors', arguments: {} });
if (monitors.isError) fail('sutramx_list_monitors', monitors);
ok('sutramx_list_monitors succeeded');
await mcp.close();

// 7. Refresh (rotation).
const refreshed = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.body.refresh_token, client_id: client.client_id, resource });
if (refreshed.status !== 200 || refreshed.body.refresh_token === tokens.body.refresh_token) fail('refresh rotates the refresh token', refreshed);
ok('refresh: new access and refresh token');
const mcp2 = await mcpWith(refreshed.body.access_token);
const again = await mcp2.callTool({ name: 'sutramx_list_monitors', arguments: {} });
if (again.isError) fail('MCP works with the refreshed token', again);
ok('MCP call with the refreshed access token');
await mcp2.close();

// 8. Revoke (RFC 7009): the whole authorization ends.
const revoke = await fetch(as.revocation_endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token: refreshed.body.refresh_token, token_type_hint: 'refresh_token', client_id: client.client_id }),
});
if (revoke.status !== 200) fail('revocation', await json(revoke));
const afterRevoke = await tokenRequest({ grant_type: 'refresh_token', refresh_token: refreshed.body.refresh_token, client_id: client.client_id });
const apiAfter = await fetch(`${apiBase}/monitors`, { headers: { Authorization: `Bearer ${refreshed.body.access_token}` } });
if (afterRevoke.body?.error !== 'invalid_grant' || apiAfter.status !== 401) fail('revoked tokens stop working', { refresh: afterRevoke, api: apiAfter.status });
ok('revoked: refresh → invalid_grant, API → 401');
console.log(`1..${step}`);
