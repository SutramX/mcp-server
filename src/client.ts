import { DEFAULT_API_URL, REQUEST_TIMEOUT_MS, USER_AGENT } from './constants.js';

/**
 * Minimal SutramX REST client authenticated with an API key
 * (Authorization: Bearer sk_...). Every request is scoped by the backend to
 * the workspace the key belongs to.
 */

export class SutramXApiError extends Error {
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

type Query = Record<string, string | number | boolean | undefined | null>;

export interface RequestOptions {
    query?: Query;
    body?: unknown;
    /** Public endpoints (e.g. /catalog) are called without the key. */
    anonymous?: boolean;
    /** Largest response body accepted (default MAX_RESPONSE_BYTES). */
    maxBytes?: number;
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

/** The backend answers errors in three shapes; normalise them. */
export function parseErrorBody(status: number, body: unknown): SutramXApiError {
    if (body && typeof body === 'object') {
        const record = body as Record<string, unknown>;
        if (record.error && typeof record.error === 'object') {
            const nested = record.error as Record<string, unknown>;
            return new SutramXApiError(status, String(nested.message || `HTTP ${status}`), nested.code ? String(nested.code) : undefined, nested.details);
        }
        if (typeof record.error === 'string') {
            const fieldErrors = Array.isArray(record.errors)
                ? (record.errors as Array<{ field?: string; message?: string; }>).map((e) => (e.field ? `${e.field}: ${e.message}` : String(e.message))).join('; ')
                : '';
            const message = fieldErrors ? `${record.error}: ${fieldErrors}` : record.error;
            const { error: _e, code: _c, errors: _errs, ...rest } = record;
            return new SutramXApiError(status, message, record.code ? String(record.code) : undefined, Object.keys(rest).length ? rest : record.errors);
        }
    }
    return new SutramXApiError(status, `HTTP ${status}`);
}

export class SutramXClient {
    readonly baseUrl: string;

    /**
     * `apiKey` is a SutramX API key (sk_…) or, in HTTP mode, an OAuth access
     * token (sxo_at_…) issued for this MCP server. `authHeaders` are sent
     * with it (never on anonymous calls).
     */
    constructor(private readonly apiKey: string, baseUrl: string = DEFAULT_API_URL, private readonly authHeaders: Record<string, string> = {}) {
        this.baseUrl = validateApiUrl(baseUrl);
    }

    async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(options.query || {})) {
            if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
        }
        const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': USER_AGENT };
        if (!options.anonymous) {
            Object.assign(headers, this.authHeaders);
            headers.Authorization = `Bearer ${this.apiKey}`;
        }
        if (options.body !== undefined) headers['Content-Type'] = 'application/json';

        let response: Response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
                // The API never redirects; a redirect must not carry the key elsewhere.
                redirect: 'error',
            });
        } catch (error) {
            const reason = (error as Error).name === 'TimeoutError' ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : (error as Error).message;
            throw new SutramXApiError(0, `Could not reach the SutramX API at ${this.baseUrl}: ${reason}`);
        }
        if (response.status === 204) return undefined as T;
        const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
        const tooLarge = () => new SutramXApiError(response.status, 'Response too large; use filters or a smaller limit');
        if (Number(response.headers.get('content-length') || 0) > maxBytes) {
            await response.body?.cancel().catch(() => undefined);
            throw tooLarge();
        }
        const text = await readBounded(response, maxBytes);
        if (text === null) throw tooLarge();
        let body: unknown = undefined;
        if (text) {
            try {
                body = JSON.parse(text);
            } catch {
                body = text;
            }
        }
        if (!response.ok) throw parseErrorBody(response.status, body);
        return body as T;
    }

    get<T>(path: string, query?: Query, anonymous = false) {
        return this.request<T>('GET', path, { query, anonymous });
    }

    post<T>(path: string, body?: unknown) {
        return this.request<T>('POST', path, { body: body ?? {} });
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
        if (error.status === 0) return 'Check SUTRAMX_API_URL and your network connection.';
        if (error.status === 401) return 'The API key is missing, wrong, revoked or disabled. Create a key in SutramX → Settings → API keys.';
        if (error.code === 'OAUTH_SCOPE_REQUIRED') return 'The user did not give this app that permission when connecting it. Tell the user; they can reconnect the SutramX connector and tick it. Do not retry.';
        if (error.code === 'OAUTH_ENDPOINT_NOT_ALLOWED') return 'Apps connected with OAuth can only use monitors, incidents and status pages. Do not retry.';
        if (error.code === 'OAUTH_INVALID_TOKEN') return 'The connection to SutramX expired or was revoked; the user must reconnect it.';
        if (error.code === 'READ_ONLY_ACCESS') return 'This API key is read-only, so it cannot change anything. Tell the user; do not retry. A workspace owner can create a standard key if changes are really needed.';
        if (error.code === 'AUTOMATION_KEY_REQUIRED') return 'Use an API key created with "Automation access".';
        if (error.code === 'FEATURE_NOT_AVAILABLE' || error.code === 'ENTITLEMENT_LIMIT_REACHED') return 'This needs a higher plan or fewer resources; tell the user rather than retrying.';
        if (error.status === 403) return 'The key is not allowed to do this (some settings are owner-only in the dashboard).';
        if (error.status === 404) return 'Check the id: list the resources first to find a valid one.';
        if (error.status === 409) return 'The resource is in a state that does not allow this (for example already resolved or paused).';
        if (error.status === 429) return 'Rate limited: wait a minute before retrying.';
        if (error.status >= 500) return 'SutramX had an internal error; retry later.';
        return '';
    })();
    return `Error (HTTP ${error.status}${code}): ${error.message}${hint ? `\nHint: ${hint}` : ''}`;
}
