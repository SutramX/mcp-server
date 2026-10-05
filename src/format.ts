import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { CHARACTER_LIMIT } from './constants.js';
import { describeApiError } from './client.js';

export const ResponseFormatSchema = z.enum(['markdown', 'json']).default('markdown')
    .describe("Output format: 'markdown' (readable summary) or 'json' (full structured data)");
export type ResponseFormat = z.infer<typeof ResponseFormatSchema>;

function truncate(text: string): string {
    if (text.length <= CHARACTER_LIMIT) return text;
    return `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. Use filters, a smaller limit or an offset to see the rest.]`;
}

/** Longest string kept in structured output; longer ones end in TRUNCATED. */
export const MAX_STRUCTURED_STRING = 8_000;
/** Marks a string cut short in structured output; never send it back to the API. */
export const TRUNCATED = '[TRUNCATED]';

// C0/C1 controls (except tab and line breaks), zero-width characters and
// bidirectional overrides: they can hide or reorder text an agent reads.
// eslint-disable-next-line no-control-regex
const UNSAFE_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function sanitizeValue(value: unknown, depth: number): unknown {
    if (typeof value === 'string') {
        const clean = value.replace(UNSAFE_CHARS, '');
        return clean.length > MAX_STRUCTURED_STRING ? `${clean.slice(0, MAX_STRUCTURED_STRING)}${TRUNCATED}` : clean;
    }
    if (value === null || typeof value !== 'object') return value;
    if (depth > 20) return TRUNCATED;
    if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.replace(UNSAFE_CHARS, '').slice(0, 200), sanitizeValue(item, depth + 1)]));
}

function size(value: unknown): number {
    return JSON.stringify(value)?.length ?? 0;
}

/** The longest array in the tree with more than one item, by serialized size. */
function largestArray(value: unknown): unknown[] | null {
    let best: unknown[] | null = null;
    let bestSize = 0;
    const visit = (node: unknown) => {
        if (Array.isArray(node)) {
            if (node.length > 1) {
                const nodeSize = size(node);
                if (nodeSize > bestSize) {
                    best = node;
                    bestSize = nodeSize;
                }
            }
            node.forEach(visit);
        } else if (node && typeof node === 'object') {
            Object.values(node).forEach(visit);
        }
    };
    visit(value);
    return best;
}

/**
 * structuredContent is data from the API (and through it from monitored
 * sites and other people): sanitized like text output and bounded to
 * CHARACTER_LIMIT so a huge or hostile response cannot flood the agent.
 * Oversized results first lose array items from the end (a page shrinks,
 * "truncated": true is set); if that is not enough only top-level scalars
 * and empty arrays are kept.
 */
export function capStructured(data: Record<string, unknown>, limit = CHARACTER_LIMIT): Record<string, unknown> {
    const clean = sanitizeValue(data, 0) as Record<string, unknown>;
    if (size(clean) <= limit) return clean;
    for (let round = 0; round < 64 && size(clean) > limit; round += 1) {
        const array = largestArray(clean);
        if (!array) break;
        array.splice(Math.max(1, Math.floor(array.length / 2)));
    }
    if (size(clean) <= limit) return { ...clean, truncated: true };
    const scalars = Object.fromEntries(Object.entries(clean)
        .filter(([, value]) => value === null || typeof value !== 'object' || Array.isArray(value))
        .map(([key, value]) => [key, Array.isArray(value) ? [] : typeof value === 'string' ? value.slice(0, 500) : value]));
    return { ...scalars, truncated: true };
}

/** True when a value read from a truncated structured result is sent back. */
export function containsTruncated(value: unknown): boolean {
    if (typeof value === 'string') return value.includes(TRUNCATED);
    if (Array.isArray(value)) return value.some(containsTruncated);
    if (value && typeof value === 'object') return Object.values(value).some(containsTruncated);
    return false;
}

/** Tool result with readable text plus capped, sanitized structuredContent. */
export function ok(data: Record<string, unknown>, markdown: string, format: ResponseFormat = 'markdown'): CallToolResult {
    const structured = capStructured(data);
    const text = format === 'json' ? JSON.stringify(structured, null, 2) : markdown;
    return { content: [{ type: 'text', text: truncate(text) }], structuredContent: structured };
}

export function fail(error: unknown): CallToolResult {
    return { content: [{ type: 'text', text: describeApiError(error) }], isError: true };
}

/** Wraps a handler so API errors become isError results the agent can act on. */
export function safely<A>(handler: (args: A) => Promise<CallToolResult>) {
    return async (args: A): Promise<CallToolResult> => {
        try {
            return await handler(args);
        } catch (error) {
            return fail(error);
        }
    };
}

export function when(value: unknown): string {
    if (!value) return 'never';
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
}

export function pct(value: unknown): string {
    return typeof value === 'number' ? `${value.toFixed(3).replace(/\.?0+$/, '')}%` : 'n/a';
}

export function paginate<T>(items: T[], offset: number, limit: number) {
    const page = items.slice(offset, offset + limit);
    const hasMore = offset + page.length < items.length;
    return { total: items.length, count: page.length, offset, items: page, has_more: hasMore, ...(hasMore ? { next_offset: offset + page.length } : {}) };
}

/** Shown instead of a credential; send it back unchanged to keep the stored value. */
export const REDACTED = '[REDACTED]';

const SECRET_KEY = /authorization|cookie|token|secret|passw(or)?d|passwd|api[-_]?key|private[-_]?key|signature|credential|bearer|session/i;

/**
 * Monitor config can hold credentials for the monitored service (request
 * headers, basic auth, tokens). Agents never need their values: replace them
 * (and passwords in URLs) with REDACTED.
 */
export function redactSecrets<T>(value: T): T {
    return redact(value, '') as T;
}

function redact(value: unknown, key: string): unknown {
    if (typeof value === 'string') {
        if (key && SECRET_KEY.test(key) && !/_names?$/i.test(key)) return value ? REDACTED : value;
        return redactUrlPassword(value);
    }
    if (Array.isArray(value)) {
        // headers as [{name, value}] pairs
        return value.map((item) => {
            if (item && typeof item === 'object' && !Array.isArray(item)) {
                const record = item as Record<string, unknown>;
                const headerName = typeof record.name === 'string' ? record.name : typeof record.key === 'string' ? record.key : '';
                if (headerName && SECRET_KEY.test(headerName) && typeof record.value === 'string') return { ...redact(record, '') as object, value: REDACTED };
            }
            return redact(item, key);
        });
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redact(item, name)]));
    }
    return value;
}

function redactUrlPassword(text: string): string {
    return text.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+@/gi, `$1${REDACTED}@`);
}

/** Puts stored values back where an update sends REDACTED unchanged. */
export function restoreRedacted(next: unknown, current: unknown): unknown {
    // Nothing stored there: keep the placeholder so the caller rejects it.
    if (next === REDACTED) return typeof current === 'string' ? current : next;
    // A URL whose password was redacted: only the unchanged URL maps back.
    if (typeof next === 'string' && next.includes(`:${REDACTED}@`)) return typeof current === 'string' && redactUrlPassword(current) === next ? current : next;
    if (Array.isArray(next)) return next.map((item, index) => restoreRedacted(item, Array.isArray(current) ? current[index] : undefined));
    if (next && typeof next === 'object') {
        const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
        return Object.fromEntries(Object.entries(next).map(([name, item]) => [name, restoreRedacted(item, base[name])]));
    }
    return next;
}

/**
 * True when a REDACTED left in `next` (after restoreRedacted) does not stand
 * for a stored value: the API masks stored credentials itself, so `current`
 * (a fresh read) shows the same masked text at the same place when there is
 * one. The API then keeps the stored value, or rejects the update (400) if
 * the monitor's target origin changed.
 */
export function hasInventedRedacted(next: unknown, current: unknown): boolean {
    if (typeof next === 'string') {
        if (!next.includes(REDACTED)) return false;
        return !(typeof current === 'string' && (current === next || redactUrlPassword(current) === next));
    }
    if (Array.isArray(next)) return next.some((item, index) => hasInventedRedacted(item, Array.isArray(current) ? current[index] : undefined));
    if (next && typeof next === 'object') {
        const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {};
        return Object.entries(next).some(([name, item]) => hasInventedRedacted(item, base[name]));
    }
    return false;
}

/** True when REDACTED appears anywhere in the value. */
export function containsRedacted(value: unknown): boolean {
    if (typeof value === 'string') return value.includes(REDACTED);
    if (Array.isArray(value)) return value.some(containsRedacted);
    if (value && typeof value === 'object') return Object.values(value).some(containsRedacted);
    return false;
}

/**
 * Text that comes from monitored sites or other people (error messages,
 * response snippets, notes): one line, no control characters, bounded, and
 * fenced so it reads as data rather than instructions.
 */
export function untrusted(value: unknown, max = 300): string {
    // eslint-disable-next-line no-control-regex
    const text = String(value ?? '').replace(UNSAFE_CHARS, '').replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
    const bounded = text.length > max ? `${text.slice(0, max)}…` : text;
    return `«${bounded.replace(/[«»]/g, '"')}»`;
}
