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
 * browser page may only call the server from an origin listed in
 * MCP_ALLOWED_ORIGINS. Loopback origins are not trusted by default: any local
 * dev server or localhost web app would otherwise drive the server (and the
 * key it falls back to on loopback).
 */
export function isAllowedOrigin(origin: string | undefined, allowedOrigins: readonly string[] = []): boolean {
    if (!origin) return true;
    if (allowedOrigins.includes('*')) return true;
    return isListedOrigin(origin, allowedOrigins);
}

/** True when the Origin is named exactly in MCP_ALLOWED_ORIGINS ("*" does not count). */
export function isListedOrigin(origin: string, allowedOrigins: readonly string[]): boolean {
    let parsed: URL;
    try {
        parsed = new URL(origin);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return allowedOrigins.some((allowed) => allowed.replace(/\/+$/, '').toLowerCase() === parsed.origin.toLowerCase());
}

/**
 * Whether a request may fall back to the server's own SUTRAMX_API_KEY: only
 * requests without an Origin (non-browser clients) or from an origin named
 * explicitly in MCP_ALLOWED_ORIGINS. A "*" entry lets browsers in with their
 * own credentials but never lends them the environment key.
 */
export function mayUseEnvKey(origin: string | undefined, allowedOrigins: readonly string[] = []): boolean {
    if (!origin) return true;
    return isListedOrigin(origin, allowedOrigins);
}
