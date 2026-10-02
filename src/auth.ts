/** SutramX API key from an "Authorization: Bearer sk_..." header, or null. */
export function bearerKey(header: string | undefined): string | null {
    if (!header) return null;
    if (header.length > 512) return null;
    const match = /^Bearer\s+(sk_[A-Za-z0-9_-]{1,256})$/i.exec(header.trim());
    return match ? match[1] : null;
}

/**
 * Browser Origin check (MCP streamable HTTP: servers must validate Origin).
 * Requests without an Origin header (CLI and desktop MCP clients) pass; a
 * browser page may only call the server from a loopback origin or one listed
 * in MCP_ALLOWED_ORIGINS. Stops a web page the user visits from driving the
 * server (and the key it falls back to on loopback).
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[] = []): boolean {
    if (!origin) return true;
    if (allowedOrigins.includes('*')) return true;
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    if (allowedOrigins.some((allowed) => allowed.replace(/\/+$/, '').toLowerCase() === parsed.origin.toLowerCase())) return true;
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && (host === 'localhost' || host === '127.0.0.1' || host === '::1');
}
