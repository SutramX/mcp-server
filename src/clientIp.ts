import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

/**
 * The end user's address in HTTP mode, a per-address limit on failed
 * credentials, and how the address is passed on to the SutramX API.
 *
 * A hosted server reaches the API from one address for every user, so the
 * API's per-address limits (e.g. failed authentications) would otherwise
 * lump all users together: one client sending junk tokens could lock
 * everyone out. Instead:
 *
 *  - TRUST_PROXY_HOPS (default 0) says how many reverse proxies in front of
 *    this server set X-Forwarded-For (Express `trust proxy`). Behind the
 *    SutramX Caddy it is 1: Caddy replaces X-Forwarded-For with the client
 *    address it determined (Cloudflare-aware). With 0 the TCP peer is used
 *    and forwarded headers are ignored.
 *  - Failed credentials (a malformed Authorization header, an OAuth token
 *    the API rejects, an API key the API rejects) are counted per address;
 *    past MCP_FAILED_AUTH_PER_IP (default 50) in 15 minutes the address gets
 *    429 + Retry-After before any token check reaches the API. Loopback and
 *    private addresses are not limited (see isPrivateAddress).
 *  - With OAUTH_RESOURCE_PROXY_SECRET set, every API call carries the
 *    address in X-SutramX-Client-Ip with X-SutramX-Client-Ip-Proof, an HMAC
 *    of it under that secret, so the API keys its own per-address limits on
 *    the end user. The raw secret never travels with API keys.
 */

export const CLIENT_IP_HEADER = 'X-SutramX-Client-Ip';
export const CLIENT_IP_PROOF_HEADER = 'X-SutramX-Client-Ip-Proof';

export const FAILED_AUTH_WINDOW_MS = 15 * 60 * 1000;
export const DEFAULT_FAILED_AUTH_PER_IP = 50;
const MAX_TRACKED_ADDRESSES = 10_000;

export function trustProxyHops(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number.parseInt((env.TRUST_PROXY_HOPS || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 10) : 0;
}

export function failedAuthLimitFromEnv(env: NodeJS.ProcessEnv = process.env): number {
    const parsed = Number.parseInt((env.MCP_FAILED_AUTH_PER_IP || '').trim(), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_FAILED_AUTH_PER_IP;
}

/** A plain IP address (IPv4-mapped IPv6 unwrapped), or null. */
export function normaliseIp(raw: string | undefined | null): string | null {
    if (!raw) return null;
    let ip = raw.trim();
    if (ip.toLowerCase().startsWith('::ffff:') && isIP(ip.slice(7)) === 4) ip = ip.slice(7);
    return isIP(ip) ? ip : null;
}

/**
 * Loopback and private addresses are never limited: such a peer is a reverse
 * proxy that TRUST_PROXY_HOPS was not set for (every user would share it, the
 * lockout this module exists to prevent) or a local health check.
 */
export function isPrivateAddress(ip: string): boolean {
    if (isIP(ip) === 4) {
        const [a, b] = ip.split('.').map(Number);
        return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
    }
    const lower = ip.toLowerCase();
    return lower === '::1' || lower === '::' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

/** IPv6 addresses are limited per /64: one host usually owns the whole block. */
function limiterKey(ip: string): string {
    if (isIP(ip) !== 6) return ip;
    const [head, tail] = ip.toLowerCase().split('::');
    const left = head ? head.split(':') : [];
    const right = tail !== undefined && tail ? tail.split(':') : [];
    const groups = tail === undefined ? left : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
    return `${groups.slice(0, 4).map((group) => group.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

/** Fixed 15-minute window per address; only failures are recorded. */
export class FailedAuthLimiter {
    private readonly entries = new Map<string, { count: number; resetAt: number; }>();

    constructor(private readonly limit = DEFAULT_FAILED_AUTH_PER_IP, private readonly windowMs = FAILED_AUTH_WINDOW_MS, private readonly maxEntries = MAX_TRACKED_ADDRESSES) {}

    /** Seconds until the address may try again, or 0 when it is not blocked. */
    retryAfter(ip: string, now = Date.now()): number {
        const entry = this.entries.get(limiterKey(ip));
        if (!entry || entry.resetAt <= now || entry.count < this.limit) return 0;
        return Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    }

    recordFailure(ip: string, now = Date.now()): void {
        const key = limiterKey(ip);
        const entry = this.entries.get(key);
        if (entry && entry.resetAt > now) {
            entry.count += 1;
            return;
        }
        this.entries.delete(key);
        if (this.entries.size >= this.maxEntries) this.evict(now);
        this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    }

    get size(): number {
        return this.entries.size;
    }

    /** Drops expired windows; if none expired, the oldest one. */
    private evict(now: number): void {
        for (const [key, entry] of this.entries) {
            if (entry.resetAt <= now) this.entries.delete(key);
        }
        if (this.entries.size >= this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
    }
}

export function clientIpProof(secret: string, ip: string): string {
    return createHmac('sha256', secret).update(`client-ip:${ip}`).digest('hex');
}

/** Headers that tell the API who the end user is; none without a secret or address. */
export function clientIpHeaders(ip: string | null, secret: string | null): Record<string, string> {
    if (!ip || !secret) return {};
    return { [CLIENT_IP_HEADER]: ip, [CLIENT_IP_PROOF_HEADER]: clientIpProof(secret, ip) };
}
