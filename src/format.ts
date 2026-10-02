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

/** Tool result with readable text plus structuredContent for programmatic use. */
export function ok(data: Record<string, unknown>, markdown: string, format: ResponseFormat = 'markdown'): CallToolResult {
    const text = format === 'json' ? JSON.stringify(data, null, 2) : markdown;
    return { content: [{ type: 'text', text: truncate(text) }], structuredContent: data };
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
