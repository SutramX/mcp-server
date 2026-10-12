import { randomUUID } from 'node:crypto';
import { DEFAULT_API_URL, REQUEST_TIMEOUT_MS, USER_AGENT } from './constants.js';

/**
 * Minimal SutramX REST client authenticated with an API key
 * (Authorization: Bearer sk_...). Every request is scoped by the backend to
 * the workspace the key belongs to.
 */

export class SutramXApiError extends Error {
    /** `category` from the error body (e.g. PLAN_LIMIT). */
    declare category?: string;
    /** Network failures (status 0): the cause code, e.g. ECONNREFUSED, ENOTFOUND, ETIMEDOUT, CERT_HAS_EXPIRED. */
    declare causeCode?: string;
    /** Retry-After of the response, in milliseconds. */
    declare retryAfterMs?: number;

    constructor(
        public readonly status: number,
        message: string,
        public readonly code?: string,
        public readonly details?: unknown
    ) {
        super(message);
        this.name = 'SutramXApiError';
    }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;
/** One retry: an agent is waiting, and can call the tool again itself. */
const MAX_ATTEMPTS = 2;
/** A longer Retry-After is reported to the agent instead of waited for. */
const MAX_RETRY_DELAY_MS = 5_000;
/** Waits for a POST that is still running on the server (409 IDEMPOTENCY_REQUEST_IN_PROGRESS). */
const MAX_IN_PROGRESS_WAITS = 10;

/** Error codes that mean "the plan does not allow this": retrying does not help. */
export const PLAN_LIMIT_CODES: ReadonlySet<string> = new Set([
    'ENTITLEMENT_LIMIT_REACHED', 'ENTITLEMENT_INTERVAL_TOO_SHORT', 'MONITOR_TOTAL_LIMIT_REACHED', 'CONNECTION_LIMIT_REACHED',
    'LIMIT_REACHED', 'AI_LIMIT_REACHED', 'FEATURE_NOT_AVAILABLE',
]);

export function isPlanLimit(error: unknown): boolean {
    return error instanceof SutramXApiError && (error.category === 'PLAN_LIMIT' || (error.code !== undefined && PLAN_LIMIT_CODES.has(error.code)));
}

/** Retry-After as milliseconds: delta-seconds or an HTTP-date; null when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
    if (value === null || value === undefined) return null;
    const trimmed = value.trim();
    if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
    const date = Date.parse(trimmed);
    if (!/[a-z]/i.test(trimmed) || Number.isNaN(date)) return null;
    return Math.max(0, date - now);
}

function oneLine(text: string, max = 200): string {
    const flat = text.replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max)}...` : flat;
}

const TLS_CODES = new Set([
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_SSL_WRONG_VERSION_NUMBER',
]);
const isTlsCode = (code: string | undefined) => Boolean(code && (code.startsWith('CERT_') || TLS_CODES.has(code)));

/** fetch() failures carry the useful part (code, message) in `cause`, sometimes nested. */
function networkError(error: unknown, host: string, timeoutMs: number): SutramXApiError {
    const err = error as (Error & { code?: string; cause?: unknown; }) | undefined;
    let code: string | undefined;
    let detail: string;
    if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        code = 'ETIMEDOUT';
        detail = `no response within ${timeoutMs / 1000}s`;
    } else {
        detail = err?.message || String(error);
        let cause: typeof err = err;
        for (let depth = 0; cause && depth < 4; depth += 1) {
            if (typeof cause.code === 'string' && !code) code = cause.code;
            if (cause !== err && cause.message) detail = cause.message;
            cause = cause.cause as typeof err;
        }
        if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT') code = 'ETIMEDOUT';
    }
    const failure = new SutramXApiError(0, `Could not reach the SutramX API at ${host}${code ? ` (${code})` : ''}: ${oneLine(detail)}`, code);
    failure.causeCode = code;
    return failure;
}

const retryableNetwork = (error: SutramXApiError) => !isTlsCode(error.causeCode) && error.causeCode !== 'ENOTFOUND' && !/redirect/i.test(error.message);

interface Transport { fetch: typeof fetch; dispatcher?: unknown; }
const PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'];
let proxyTransport: { signature: string; transport: Promise<Transport>; } | undefined;

/**
 * HTTPS_PROXY / HTTP_PROXY / NO_PROXY: Node's fetch ignores them, so when one
 * is set requests go through undici's EnvHttpProxyAgent (which also honours
 * NO_PROXY, e.g. for SUTRAMX_API_INTERNAL_URL). Nothing extra is loaded otherwise.
 */
function transport(env: NodeJS.ProcessEnv = process.env): Promise<Transport> | Transport {
    if (!PROXY_VARIABLES.some((name) => env[name])) return { fetch: globalThis.fetch };
    const signature = [...PROXY_VARIABLES, 'NO_PROXY', 'no_proxy'].map((name) => env[name] ?? '').join('\n');
    if (proxyTransport?.signature !== signature) {
        proxyTransport = {
            signature,
            transport: import('undici').then((undici) => ({ fetch: undici.fetch as unknown as typeof fetch, dispatcher: new undici.EnvHttpProxyAgent() })),
        };
    }
    return proxyTransport.transport;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The key goes in every request: https only (plain http just for loopback). */
export function validateApiUrl(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('SUTRAMX_API_URL is not a valid URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('SUTRAMX_API_URL must not contain credentials, a query string or a fragment');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && LOOPBACK.has(parsed.hostname.toLowerCase()))) {
        throw new Error(`Refusing to send API keys to ${parsed.origin}: SUTRAMX_API_URL must use https:// (plain http only for localhost)`);
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

function isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (LOOPBACK.has(host)) return true;
    // A single-label name (no dots) is a container/service name on a private network, e.g. `api`.
    if (/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host) && !/^\d+$/.test(host)) return true;
    const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
    if (v4) {
        const [a, b] = [Number(v4[1]), Number(v4[2])];
        return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    }
    return host.startsWith('fc') || host.startsWith('fd');
}

/**
 * SUTRAMX_API_INTERNAL_URL: where a hosted server sends its API calls when it
 * runs next to the API (e.g. `http://api:3003` on the compose network), so
 * they skip the public edge. Plain http is allowed only for loopback, private
 * addresses and single-label (container) host names; anything else must be
 * https like SUTRAMX_API_URL.
 */
export function validateInternalApiUrl(raw: string): string {
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new Error('SUTRAMX_API_INTERNAL_URL is not a valid URL');
    }
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('SUTRAMX_API_INTERNAL_URL must not contain credentials, a query string or a fragment');
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isPrivateHost(parsed.hostname))) {
        throw new Error(`Refusing to send API keys to ${parsed.origin}: SUTRAMX_API_INTERNAL_URL must use https:// (plain http only for loopback, private addresses and container names)`);
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, '');
}

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    query?: Query;
    body?: unknown;
    /** Public endpoints (e.g. /catalog) are called without the key. */
    anonymous?: boolean;
    /** Largest response body accepted (default MAX_RESPONSE_BYTES). */
    maxBytes?: number;
    /** Idempotency-Key for a POST; one is generated when left out. */
    idempotencyKey?: string;
}

/** Reads at most maxBytes of the body, whatever Content-Length claims. */
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/** Parsed JSON, the text itself when it is not JSON, undefined when empty. */
function parseJson(text: string): unknown {
    if (!text) return undefined;
    try {
        return JSON.parse(text);
    } catch {
        return text;
    }
}

/**
 * POST routes the API runs at most once per Idempotency-Key. Mirrors
 * IDEMPOTENT_ROUTES in backend/src/middleware/idempotency.ts (path after the
 * optional /v1 prefix, no trailing slash): keep the two lists in step. Only
 * these POSTs are retried; every other POST (acknowledge, resolve, run-check,
 * pause, resume, test, rotate-secret ...) is sent once, because the API would
 * run it again.
 */
const IDEMPOTENT_POST_ROUTES: readonly RegExp[] = [
    /^\/monitors$/,
    /^\/monitors\/bulk$/,
    /^\/monitors\/detect\/apply$/,
    /^\/monitor-groups$/,
    /^\/status\/pages$/,
    /^\/status\/pages\/[^/]+\/monitors$/,
    /^\/integrations\/[^/]+\/connections$/,
    /^\/integrations\/[^/]+\/connect$/,
    /^\/incidents$/,
    /^\/incidents\/runbooks$/,
    /^\/incidents\/[^/]+\/notes$/,
    /^\/maintenance$/,
    /^\/automation\/monitors\/apply$/,
];

/**
 * POST routes that only read (nothing changes on the server), so a retry is
 * safe without an Idempotency-Key. Not deduped by the API: keep them out of
 * IDEMPOTENT_POST_ROUTES.
 */
const SAFE_POST_ROUTES: readonly RegExp[] = [
    /^\/automation\/monitors\/plan$/,
];

/** `path` without query string, fragment, /api or /v1 prefix and trailing slash. */
function routeOf(path: string): string {
    const normalized = path.split(/[?#]/, 1)[0].replace(/^\/api(?=\/|$)/, '').replace(/^\/v1(?=\/|$)/, '');
    return normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized;
}

/**
 * True when a POST to `path` (no query string; an /api or /v1 prefix and a
 * trailing slash are ignored) is one the API dedupes by Idempotency-Key.
 */
export function isIdempotentPostRoute(path: string): boolean {
    const route = routeOf(path);
    return IDEMPOTENT_POST_ROUTES.some((pattern) => pattern.test(route));
}

/** True when a POST to `path` only reads, so it may be retried like a GET. */
export function isSafePostRoute(path: string): boolean {
    const route = routeOf(path);
    return SAFE_POST_ROUTES.some((pattern) => pattern.test(route));
}

/** The backend answers errors in three shapes; normalise them. */
export function parseErrorBody(status: number, body: unknown): SutramXApiError {
    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (record.error && typeof record.error === 'object') {
            const nested = record.error as Record<string, unknown>;
            const error = new SutramXApiError(status, String(nested.message || `HTTP ${status}`), nested.code ? String(nested.code) : undefined, nested.details);
            const category = record.category ?? nested.category;
            if (typeof category === 'string') error.category = category;
            return error;
        }
        if (typeof record.error === 'string') {
            const fieldErrors = Array.isArray(record.errors)
                ? (record.errors as Array<{ field?: string; message?: string; }>).map((e) => (e.field ? `${e.field}: ${e.message}` : String(e.message))).join('; ')
                : '';
            const message = fieldErrors ? `${record.error}: ${fieldErrors}` : record.error;
            const { error: _e, code: _c, errors: _errs, ...rest } = record;
            const error = new SutramXApiError(status, message, record.code ? String(record.code) : undefined, Object.keys(rest).length ? rest : record.errors);
            if (typeof record.category === 'string') error.category = record.category;
            return error;
        }
    }
    // Plain-text 429 (older rate limiters): keep its readable message, never an HTML page.
    if (status === 429) {
        const readable = typeof body === 'string' && body.trim() && !body.trimStart().startsWith('<');
        return new SutramXApiError(status, readable ? oneLine(body) : `HTTP ${status}`, 'RATE_LIMITED');
    }
    return new SutramXApiError(status, `HTTP ${status}`);
}

export interface ClientOptions {
    /** Sent with every call, anonymous ones too (the end user's address, see clientIp.ts). */
    relayHeaders?: Record<string, string>;
    /** `baseUrl` is SUTRAMX_API_INTERNAL_URL: validated with validateInternalApiUrl. */
    internal?: boolean;
    /** Called when the API rejects the credential (HTTP 401). */
    onAuthFailure?: () => void;
}

export class SutramXClient {
    readonly baseUrl: string;

    /**
     * `apiKey` is a SutramX API key (sk_…) or, in HTTP mode, an OAuth access
     * token (sxo_at_…) issued for this MCP server. `authHeaders` are sent
     * with it (never on anonymous calls).
     */
    constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_API_URL, private readonly authHeaders: Record<string, string> = {}, private readonly clientOptions: ClientOptions = {}) {
        this.baseUrl = clientOptions.internal ? validateInternalApiUrl(baseUrl) : validateApiUrl(baseUrl);
    }

    /** Delay before a retry (tests set it to 0). */
    retryDelay: (attempt: number, retryAfter: string | null) => number = (attempt, retryAfter) => parseRetryAfter(retryAfter) ?? 300 * 2 ** attempt + Math.floor(Math.random() * 200);

    async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const headers: Record<string, string> = { ...this.clientOptions.relayHeaders, Accept: 'application/json', 'User-Agent': USER_AGENT, 'X-SutramX-Client': USER_AGENT };
        if (!options.anonymous) {
            Object.assign(headers, this.authHeaders);
            headers.Authorization = `Bearer ${this.apiKey}`;
        }
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';
        // One key per tool call's POST, reused by its retry: on the routes the
        // API dedupes (IDEMPOTENT_POST_ROUTES) it then runs once; other routes
        // and older APIs ignore it.
        const idempotencyKey = method === 'POST' ? (options.idempotencyKey ?? randomUUID()) : undefined;
        if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
        const basePath = new URL(this.baseUrl).pathname.replace(/\/+$/, '');
        const routePath = basePath && url.pathname.startsWith(`${basePath}/`) ? url.pathname.slice(basePath.length) : url.pathname;
        const dedupedPost = idempotencyKey !== undefined && isIdempotentPostRoute(routePath);
        // 429 is retried for every method: the API's rate limiters answer
        // before the handler, so the request did not run. 502/503/504,
        // timeouts and network errors: GET, PUT, DELETE, the POSTs the API
        // dedupes by their Idempotency-Key and the read-only POSTs
        // (SAFE_POST_ROUTES). Any other POST (an action) is sent once.
        const retrySafe = method === 'GET' || method === 'PUT' || method === 'DELETE' || dedupedPost || (method === 'POST' && isSafePostRoute(routePath));
        const deadline = Date.now() + REQUEST_TIMEOUT_MS * 2;
        const { fetch: fetchImpl, dispatcher } = await transport();
        const payload = options.body !== undefined ? JSON.stringify(options.body) : undefined;
        const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
        const nextDelay = (attempt: number, retryAfter: string | null): number | null => {
            if (attempt >= MAX_ATTEMPTS - 1) return null;
            const delay = Math.max(0, this.retryDelay(attempt, retryAfter));
            return delay > MAX_RETRY_DELAY_MS || Date.now() + delay >= deadline ? null : delay;
        };

        let response: Response;
        let text: string | undefined;
        let inProgressWaits = 0;
        for (let attempt = 0; ; attempt += 1) {
            const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now()));
            try {
                response = await fetchImpl(url, {
                    method,
                    headers,
                    body: payload,
                    signal: AbortSignal.timeout(timeout),
                    // The API never redirects; a redirect must not carry the key elsewhere.
                    redirect: 'error',
                    ...(dispatcher ? { dispatcher } : {}),
                } as RequestInit);
            } catch (error) {
                const failure = networkError(error, url.host, REQUEST_TIMEOUT_MS);
                const delay = retrySafe && retryableNetwork(failure) ? nextDelay(attempt, null) : null;
                if (delay === null) throw failure;
                await sleep(delay);
                continue;
            }
            text = undefined;
            const status = response.status;
            if (status === 409 && dedupedPost) {
                text = await this.read(response, maxBytes, url.host);
                // The same POST is still running on the server: wait, then ask again with the same key.
                if (parseErrorBody(status, parseJson(text)).code === 'IDEMPOTENCY_REQUEST_IN_PROGRESS' && inProgressWaits < MAX_IN_PROGRESS_WAITS) {
                    inProgressWaits += 1;
                    const delay = Math.min(Math.max(0, this.retryDelay(0, response.headers.get('retry-after') ?? '1')), MAX_RETRY_DELAY_MS);
                    if (Date.now() + delay < deadline) {
                        await sleep(delay);
                        attempt -= 1; // not a failed attempt
                        continue;
                    }
                }
            }
            if (status === 429 || (retrySafe && [502, 503, 504].includes(status))) {
                text = await this.read(response, maxBytes, url.host);
                // A plan limit can come as 429 (AI drafts): waiting does not help.
                const delay = isPlanLimit(parseErrorBody(status, parseJson(text))) ? null : nextDelay(attempt, response.headers.get('retry-after'));
                if (delay !== null) {
                    await sleep(delay);
                    continue;
                }
            }
            break;
        }
        if (response.status === 401 && !options.anonymous) this.clientOptions.onAuthFailure?.();
        if (response.status === 204 || response.status === 205) return undefined as T;
        if (text === undefined) text = await this.read(response, maxBytes, url.host);
        if (!response.ok) {
            const error = parseErrorBody(response.status, parseJson(text));
            const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
            if (retryAfter !== null) error.retryAfterMs = retryAfter;
            throw error;
        }
        if (!text.trim()) return undefined as T;
        try {
            return JSON.parse(text) as T;
        } catch {
            const type = response.headers.get('content-type') || 'no content type';
            throw new SutramXApiError(response.status, `Expected JSON from the SutramX API at ${url.host} but got ${oneLine(type, 60)} ("${oneLine(text, 80)}"); a proxy or a wrong SUTRAMX_API_URL can cause this`, 'INVALID_RESPONSE');
        }
    }

    /** The body, at most maxBytes of it whatever Content-Length claims. */
    private async read(response: Response, maxBytes: number, host: string): Promise<string> {
        const tooLarge = () => new SutramXApiError(response.status, 'Response too large; use filters or a smaller limit', 'RESPONSE_TOO_LARGE');
        if (Number(response.headers.get('content-length') || 0) > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge();
        }
        let text: string | null;
        try {
            text = await readBounded(response, maxBytes);
        } catch (error) {
            throw networkError(error, host, REQUEST_TIMEOUT_MS);
        }
        if (text === null) throw tooLarge();
        return text;
    }

    get<T>(path: string, query?: Query, anonymous = false) {
        return this.request<T>('GET', path, { query, anonymous });
    }

    post<T>(path: string, body?: unknown, options: { idempotencyKey?: string; } = {}) {
        return this.request<T>('POST', path, { ...options, body: body ?? {} });
    }

    put<T>(path: string, body?: unknown) {
        return this.request<T>('PUT', path, { body: body ?? {} });
    }

    patch<T>(path: string, body?: unknown) {
        return this.request<T>('PATCH', path, { body: body ?? {} });
    }

    delete<T>(path: string) {
        return this.request<T>('DELETE', path);
    }
}

/** Actionable text for an agent, by status/code. */
export function describeApiError(error: unknown): string {
    if (!(error instanceof SutramXApiError)) return `Error: ${(error as Error)?.message || String(error)}`;
    const code = error.code ? ` [${error.code}]` : '';
    const hint = (() => {
        if (error.status === 0) {
            if (error.causeCode === 'ETIMEDOUT') return 'The SutramX API did not answer in time; retry in a minute.';
            if (isTlsCode(error.causeCode)) return 'The TLS certificate could not be verified (a TLS-inspecting proxy needs NODE_EXTRA_CA_CERTS). Tell the user; do not retry.';
            return 'Check SUTRAMX_API_URL, HTTPS_PROXY / NO_PROXY and the network connection.';
        }
        if (isPlanLimit(error)) return 'This needs a higher plan or fewer resources; tell the user rather than retrying.';
        if (error.status === 401) return 'The API key is missing, wrong, revoked or disabled. Create a key in SutramX → Settings → API keys.';
        if (error.code === 'OAUTH_SCOPE_REQUIRED') return 'The user did not give this app that permission when connecting it. Tell the user; they can reconnect the SutramX connector and tick it. Do not retry.';
        if (error.code === 'OAUTH_ENDPOINT_NOT_ALLOWED') return 'Apps connected with OAuth can only use monitors, incidents and status pages. Do not retry.';
        if (error.code === 'OAUTH_INVALID_TOKEN') return 'The connection to SutramX expired or was revoked; the user must reconnect it.';
        if (error.code === 'READ_ONLY_ACCESS') return 'This API key is read-only, so it cannot change anything. Tell the user; do not retry. A workspace owner can create a standard key if changes are really needed.';
        if (error.code === 'AUTOMATION_KEY_REQUIRED') return 'Use an API key created with "Automation access".';
        if (error.status === 403) return 'The key is not allowed to do this (some settings are owner-only in the dashboard).';
        if (error.status === 404) return 'Check the id: list the resources first to find a valid one.';
        if (error.status === 409) return 'The resource is in a state that does not allow this (for example already resolved or paused).';
        if (error.status === 429) return error.retryAfterMs !== undefined ? `Rate limited: wait ${Math.ceil(error.retryAfterMs / 1000)}s before retrying.` : 'Rate limited: wait a minute before retrying.';
        if (error.status >= 500) return 'SutramX had an internal error; retry later.';
        return '';
    })();
    const where = error.status === 0 ? 'network' : `HTTP ${error.status}${code}`;
    return `Error (${where}): ${error.message}${hint ? `\nHint: ${hint}` : ''}`;
}
