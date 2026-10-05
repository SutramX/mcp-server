#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createMcpExpressApp } from '@modelcontextprotocol/sdk/server/express.js';
import type { NextFunction, Request, Response } from 'express';
import { SutramXClient, validateApiUrl } from './client.js';
import { policyFromEnv, ToolPolicy, truthy } from './policy.js';
import { isAllowedOrigin } from './auth.js';
import { bearerChallenge, bearerCredential, checkOAuthToken, oauthResourceConfig, protectedResourceMetadata, RESOURCE_PROOF_HEADER, resourceMetadataPaths, type Credential } from './oauth.js';
import { DEFAULT_API_URL, SERVER_NAME, SERVER_VERSION } from './constants.js';
import { createSutramXServer } from './server.js';

/**
 * Transports:
 *  stdio (default)   one user; key from SUTRAMX_API_KEY. For Claude Code,
 *                    Claude Desktop and other local MCP clients.
 *  --http            streamable HTTP at POST /mcp (stateless, JSON responses).
 *                    Each request authenticates with its own SutramX API key
 *                    (Authorization: Bearer sk_...), so one server can serve
 *                    many users. SUTRAMX_API_KEY is used as a fallback only
 *                    while the server listens on loopback, and only for
 *                    requests that send no Authorization header at all.
 *                    Browser requests must come from a loopback origin or
 *                    one in MCP_ALLOWED_ORIGINS.
 *                    Remote clients without a key (e.g. Claude.ai custom
 *                    connectors) sign in with OAuth 2.1 instead: a request
 *                    without credentials gets 401 + WWW-Authenticate pointing
 *                    at /.well-known/oauth-protected-resource, which names
 *                    the SutramX API as authorization server; the resulting
 *                    access token (sxo_at_...) is checked with the API and
 *                    limited to the scopes the user granted (see oauth.ts).
 */

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

function apiUrl(): string {
    return validateApiUrl(process.env.SUTRAMX_API_URL || DEFAULT_API_URL);
}

function describePolicy(policy: ToolPolicy): string {
    return policy.readOnly ? 'read-only' : policy.allowDestructive ? 'read-write, deletes enabled' : 'read-write, deletes disabled';
}

function startupChecks(): void {
    apiUrl(); // fail fast on an unsafe SUTRAMX_API_URL
    if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
        console.error('Warning: NODE_TLS_REJECT_UNAUTHORIZED=0 disables TLS certificate checks; API keys can be intercepted.');
    }
}

function requireEnvKey(): string {
    const key = process.env.SUTRAMX_API_KEY?.trim();
    if (!key) {
        console.error('SUTRAMX_API_KEY is not set. Create an API key in SutramX → Settings → API keys and pass it in the MCP client config.');
        process.exit(1);
    }
    if (!key.startsWith('sk_')) console.error('Warning: SutramX API keys start with "sk_".');
    if (/[\r\n]/.test(key)) {
        console.error('SUTRAMX_API_KEY contains a line break.');
        process.exit(1);
    }
    return key;
}

async function runStdio(): Promise<void> {
    startupChecks();
    const policy = policyFromEnv();
    const server = createSutramXServer(new SutramXClient(requireEnvKey(), apiUrl()), policy);
    await server.connect(new StdioServerTransport());
    console.error(`${SERVER_NAME} ${SERVER_VERSION} running on stdio (API ${apiUrl()}, ${describePolicy(policy)})`);
}

function jsonRpcError(res: Response, status: number, message: string, code = -32001): void {
    res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

function csv(value: string | undefined): string[] {
    return (value || '').split(',').map((item) => item.trim()).filter(Boolean);
}

async function runHttp(): Promise<void> {
    startupChecks();
    const serverPolicy = policyFromEnv();
    const host = process.env.HOST || '127.0.0.1';
    const port = Number.parseInt(process.env.PORT || '3333', 10);
    const allowedHosts = csv(process.env.MCP_ALLOWED_HOSTS);
    const allowedOrigins = csv(process.env.MCP_ALLOWED_ORIGINS);
    const loopback = LOOPBACK_HOSTS.has(host);
    const envKey = loopback ? process.env.SUTRAMX_API_KEY?.trim() || null : null;
    if (!loopback && process.env.SUTRAMX_API_KEY) {
        console.error('SUTRAMX_API_KEY is ignored when HOST is not loopback: every request must send its own Authorization: Bearer sk_... header.');
    }

    const oauth = oauthResourceConfig(apiUrl());
    const app = createMcpExpressApp({ host, ...(allowedHosts?.length ? { allowedHosts } : {}) });

    // RFC 9728 metadata: public, any origin (browser-based MCP clients read it).
    const metadata = protectedResourceMetadata(oauth);
    for (const path of resourceMetadataPaths(oauth.resource)) {
        app.options(path, (_req: Request, res: Response) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
            res.setHeader('Access-Control-Allow-Headers', 'MCP-Protocol-Version');
            res.status(204).end();
        });
        app.get(path, (_req: Request, res: Response) => {
            res.setHeader('Access-Control-Allow-Origin', '*');
            res.setHeader('Cache-Control', 'public, max-age=3600');
            res.json(metadata);
        });
    }

    app.use((req: Request, res: Response, next: NextFunction) => {
        if (isAllowedOrigin(req.headers.origin, allowedOrigins)) return next();
        jsonRpcError(res, 403, `Origin not allowed: ${String(req.headers.origin).slice(0, 100)}. Add it to MCP_ALLOWED_ORIGINS to allow it.`, -32000);
    });

    app.get('/health', (_req: Request, res: Response) => {
        res.json({ status: 'ok', name: SERVER_NAME, version: SERVER_VERSION });
    });

    app.post('/mcp', async (req: Request, res: Response) => {
        // An Authorization header that is not a SutramX key or OAuth access
        // token is rejected, never replaced by the server's own key.
        const sent = req.headers.authorization;
        const credential: Credential | null = sent !== undefined ? bearerCredential(sent) : envKey ? { kind: 'api_key', token: envKey } : null;
        if (!credential) {
            res.setHeader('WWW-Authenticate', bearerChallenge(oauth, sent !== undefined ? { error: 'invalid_token', error_description: 'Unrecognised credential' } : {}));
            return jsonRpcError(res, 401, 'Sign in to SutramX (OAuth), or send your SutramX API key as "Authorization: Bearer sk_..."');
        }
        // Per request, the user's client config may narrow (read-only) or opt
        // into deletes; the server env can force read-only for everyone.
        const policy: ToolPolicy = {
            readOnly: serverPolicy.readOnly || truthy(req.headers['x-sutramx-read-only']),
            allowDestructive: serverPolicy.allowDestructive || truthy(req.headers['x-sutramx-allow-destructive']),
        };
        const authHeaders: Record<string, string> = {};
        if (credential.kind === 'oauth') {
            // Audience + liveness check before any tool runs (MCP spec: the
            // server validates tokens were issued for it; invalid → 401).
            const check = await checkOAuthToken(credential.token, apiUrl(), oauth);
            if (!check.ok) {
                if (check.status === 401) {
                    res.setHeader('WWW-Authenticate', bearerChallenge(oauth, { error: 'invalid_token', error_description: check.description }));
                }
                return jsonRpcError(res, check.status, check.description);
            }
            // No write scope (or the user's role is now view-only): read tools only.
            if (check.info.readOnly) policy.readOnly = true;
            if (oauth.resourceProofSecret) authHeaders[RESOURCE_PROOF_HEADER] = oauth.resourceProofSecret;
        }
        // Stateless: a fresh server + transport per request keeps users isolated.
        const server = createSutramXServer(new SutramXClient(credential.token, apiUrl(), authHeaders), policy);
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
        res.on('close', () => {
            void transport.close();
            void server.close();
        });
        try {
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
        } catch (error) {
            console.error('MCP request failed:', (error as Error).message);
            if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
        }
    });

    // Stateless server: no SSE stream or session to resume or delete.
    const methodNotAllowed = (_req: Request, res: Response) => {
        res.setHeader('Allow', 'POST');
        jsonRpcError(res, 405, 'Method not allowed: use POST /mcp');
    };
    app.get('/mcp', methodNotAllowed);
    app.delete('/mcp', methodNotAllowed);

    // Body parser failures (malformed JSON, too large) as JSON-RPC errors, not Express HTML.
    app.use((error: Error & { status?: number; type?: string; }, _req: Request, res: Response, next: NextFunction) => {
        if (res.headersSent) return next(error);
        if (error.type === 'entity.parse.failed') return jsonRpcError(res, 400, 'Parse error: the body is not valid JSON', -32700);
        if (error.type === 'entity.too.large') return jsonRpcError(res, 413, 'Request body too large', -32600);
        console.error('MCP request failed:', error.message);
        jsonRpcError(res, error.status && error.status < 500 ? error.status : 500, error.status && error.status < 500 ? error.message : 'Internal server error', -32603);
    });

    app.listen(port, host, () => {
        console.error(`${SERVER_NAME} ${SERVER_VERSION} listening on http://${host.includes(':') ? `[${host}]` : host}:${port}/mcp (API ${apiUrl()}, default ${describePolicy(serverPolicy)})`);
    });
}

const useHttp = process.argv.includes('--http') || process.env.TRANSPORT === 'http';
(useHttp ? runHttp() : runStdio()).catch((error) => {
    console.error('Fatal:', error);
    process.exit(1);
});
