import { createHash } from 'node:crypto';
import { REQUEST_TIMEOUT_MS, USER_AGENT } from './constants.js';

/**
 * OAuth 2.1 protected-resource side of the HTTP transport (MCP authorization
 * spec; RFC 9728 / RFC 6750 / RFC 8707).
 *
 *  - Protected Resource Metadata at /.well-known/oauth-protected-resource
 *    (and the path-inserted form for the /mcp endpoint) names the SutramX API
 *    as the authorization server.
 *  - A request without a credential gets 401 + WWW-Authenticate with
 *    resource_metadata, which starts the client's OAuth flow.
 *  - OAuth access tokens (sxo_at_…) are checked against the API's
 *    /oauth/token-info before any tool runs: unknown, expired or revoked
 *    tokens, and tokens issued for another resource (audience), get 401.
 *  - SutramX API keys (sk_…) keep working exactly as before.
 *
 * Env (HTTP mode):
 *  MCP_RESOURCE_URL          canonical URL of this MCP endpoint (default <SUTRAMX_API_URL>/mcp)
 *  MCP_AUTHORIZATION_SERVER  issuer of the authorization server (default SUTRAMX_API_URL)
 *  OAUTH_RESOURCE_PROXY_SECRET  sent to the API with OAuth tokens
 *                            (X-SutramX-Resource-Proof). At least 16 characters;
 *                            required when NODE_ENV=production unless
 *                            MCP_OAUTH=off (see oauthStartupProblem)
 *  MCP_OAUTH                 "off" disables OAuth in HTTP mode: no metadata,
 *                            OAuth access tokens are refused, API keys only
 */

export const OAUTH_ACCESS_TOKEN_PREFIX = 'sxo_at_';
export const RESOURCE_PROOF_HEADER = 'X-SutramX-Resource-Proof';
export const OAUTH_SCOPES = [
    'monitors:read',
    'monitors:write',
    'incidents:read',
    'incidents:write',
    'status_pages:read',
    'status_pages:write',
] as const;
const WRITE_SCOPES = new Set(['monitors:write', 'incidents:write', 'status_pages:write']);

export interface OAuthResourceConfig {
    resource: string;
    authorizationServer: string;
    resourceProofSecret: string | null;
}

function stripSlash(value: string): string {
    return value.replace(/\/+$/, '');
}

/** Canonical URL (lowercase scheme/host, no default port, no trailing slash). */
export function canonicalResource(raw: string): string {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('MCP_RESOURCE_URL must be an http(s) URL');
    if (parsed.search || parsed.hash) throw new Error('MCP_RESOURCE_URL must not have a query or fragment');
    return stripSlash(`${parsed.origin}${parsed.pathname}`);
}

export const MIN_RESOURCE_PROOF_LENGTH = 16;

/** OAuth is on in HTTP mode unless the operator sets MCP_OAUTH=off. */
export function oauthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    return !['off', 'false', '0', 'no'].includes((env.MCP_OAUTH || '').trim().toLowerCase());
}

/**
 * Startup check for HTTP mode. Without a usable resource proof the server
 * would forward OAuth tokens to the API without X-SutramX-Resource-Proof, so
 * in production a missing or short OAUTH_RESOURCE_PROXY_SECRET is a
 * configuration error, never a silent downgrade. Returns the error message,
 * or null when the server may start.
 */
export function oauthStartupProblem(env: NodeJS.ProcessEnv = process.env): string | null {
    if (!oauthEnabled(env)) return null;
    const proof = (env.OAUTH_RESOURCE_PROXY_SECRET || '').trim();
    if (proof.length >= MIN_RESOURCE_PROOF_LENGTH) return null;
    if ((env.NODE_ENV || '').trim() !== 'production') return null;
    const why = proof ? `is shorter than ${MIN_RESOURCE_PROOF_LENGTH} characters` : 'is not set';
    return `OAUTH_RESOURCE_PROXY_SECRET ${why}. With NODE_ENV=production the HTTP server needs it (at least ${MIN_RESOURCE_PROOF_LENGTH} characters, the value the SutramX API expects in ${RESOURCE_PROOF_HEADER}) to accept OAuth tokens. Set it, or set MCP_OAUTH=off to accept API keys only.`;
}

export function oauthResourceConfig(apiUrl: string, env: NodeJS.ProcessEnv = process.env): OAuthResourceConfig {
    const resource = canonicalResource((env.MCP_RESOURCE_URL || `${apiUrl}/mcp`).trim());
    const authorizationServer = stripSlash((env.MCP_AUTHORIZATION_SERVER || apiUrl).trim());
    const proof = (env.OAUTH_RESOURCE_PROXY_SECRET || '').trim();
    return { resource, authorizationServer, resourceProofSecret: proof.length >= MIN_RESOURCE_PROOF_LENGTH ? proof : null };
}

/** RFC 9728 §3: the metadata URL for a resource with a path inserts the path after the well-known suffix. */
export function resourceMetadataUrl(resource: string): string {
    const parsed = new URL(resource);
    const path = stripSlash(parsed.pathname);
    return `${parsed.origin}/.well-known/oauth-protected-resource${path}`;
}

/** Paths (on this server) the metadata is served at: path-inserted and root. */
export function resourceMetadataPaths(resource: string): string[] {
    const path = stripSlash(new URL(resource).pathname);
    return Array.from(new Set([`/.well-known/oauth-protected-resource${path}`, '/.well-known/oauth-protected-resource']));
}

export function protectedResourceMetadata(config: OAuthResourceConfig) {
    return {
        resource: config.resource,
        authorization_servers: [config.authorizationServer],
        scopes_supported: [...OAUTH_SCOPES],
        bearer_methods_supported: ['header'],
        resource_name: 'SutramX',
        resource_documentation: 'https://github.com/sutramx/mcp-server#readme',
    };
}

function quote(value: string): string {
    return `"${value.replace(/["\\\r\n]/g, '')}"`;
}

/** RFC 6750 §3 / RFC 9728 §5.1 challenge. */
export function bearerChallenge(config: OAuthResourceConfig, params: Record<string, string> = {}): string {
    const all = { ...params, resource_metadata: resourceMetadataUrl(config.resource) };
    return `Bearer ${Object.entries(all).map(([key, value]) => `${key}=${quote(value)}`).join(', ')}`;
}

export type Credential =
    | { kind: 'api_key'; token: string; }
    | { kind: 'oauth'; token: string; };

/**
 * The Bearer credential: a SutramX API key or an OAuth access token. Anything
 * else (including a malformed header) is null.
 */
export function bearerCredential(header: string | undefined): Credential | null {
    if (!header || header.length > 512) return null;
    const match = /^Bearer\s+((?:sk_|sxo_at_)[A-Za-z0-9_-]{1,256})$/i.exec(header.trim());
    if (!match) return null;
    return match[1].startsWith(OAUTH_ACCESS_TOKEN_PREFIX) ? { kind: 'oauth', token: match[1] } : { kind: 'api_key', token: match[1] };
}

export interface TokenInfo {
    scopes: string[];
    readOnly: boolean;
    workspaceId: string | null;
    clientName: string | null;
    expiresAt: number;
}

export type TokenCheck = { ok: true; info: TokenInfo; } | { ok: false; status: 401 | 403 | 503; description: string; };

const CACHE_TTL_MS = 30_000;
const CACHE_MAX = 1000;
const cache = new Map<string, { at: number; result: TokenCheck; }>();

export function clearTokenCache(): void {
    cache.clear();
}

/**
 * Validates an OAuth access token with the authorization server and checks it
 * was issued for this resource. Positive results are cached for 30 s (never
 * past the token's expiry); a revoked token therefore stops working here
 * within 30 s and at the API immediately.
 */
export async function checkOAuthToken(token: string, apiUrl: string, config: OAuthResourceConfig, now = Date.now(), relayHeaders: Record<string, string> = {}): Promise<TokenCheck> {
    const key = createHash('sha256').update(token).digest('hex');
    const cached = cache.get(key);
    if (cached && now - cached.at < CACHE_TTL_MS && (!cached.result.ok || cached.result.info.expiresAt * 1000 > now)) return cached.result;

    let response: Response;
    try {
        const headers: Record<string, string> = { ...relayHeaders, Accept: 'application/json', 'User-Agent': USER_AGENT, Authorization: `Bearer ${token}` };
        if (config.resourceProofSecret) headers[RESOURCE_PROOF_HEADER] = config.resourceProofSecret;
        response = await fetch(`${apiUrl}/oauth/token-info`, { headers, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (error) {
        return { ok: false, status: 503, description: `Could not reach the authorization server: ${(error as Error).message}` };
    }
    let result: TokenCheck;
    if (response.status === 401 || response.status === 400) {
        result = { ok: false, status: 401, description: 'The access token is invalid, expired or revoked' };
    } else if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return { ok: false, status: response.status === 403 ? 403 : 503, description: `Token check failed (HTTP ${response.status})` };
    } else {
        const body = await response.json().catch(() => null) as Record<string, unknown> | null;
        if (!body || body.active !== true || typeof body.aud !== 'string') {
            result = { ok: false, status: 401, description: 'The access token is not active' };
        } else if (canonicalResourceSafe(body.aud) !== config.resource) {
            result = { ok: false, status: 401, description: 'The access token was issued for another resource' };
        } else {
            const scopes = typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [];
            result = {
                ok: true,
                info: {
                    scopes,
                    readOnly: body.read_only === true || !scopes.some((scope) => WRITE_SCOPES.has(scope)),
                    workspaceId: typeof body.workspace_id === 'string' ? body.workspace_id : null,
                    clientName: typeof body.client_name === 'string' ? body.client_name : null,
                    expiresAt: typeof body.exp === 'number' ? body.exp : Math.floor(now / 1000) + 60,
                },
            };
        }
    }
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: now, result });
    return result;
}

function canonicalResourceSafe(raw: string): string | null {
    try {
        return canonicalResource(raw);
    } catch {
        return null;
    }
}
