import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SutramXClient } from '../client.js';
import { ok, ResponseFormatSchema, safely } from '../format.js';
import type { StatusPage } from '../types.js';

const StatusPageIdSchema = z.string().uuid().describe('Status page id (UUID). Use sutramx_list_status_pages to find it.');

function pageLine(page: StatusPage): string {
    const visibility = page.is_public ? 'public' : 'not public';
    const domain = page.custom_domain ? ` · ${page.custom_domain}` : '';
    return `- **${page.title}** (${page.id}) slug=${page.slug} · ${visibility} · ${page.monitor_count ?? page.monitors?.length ?? 0} monitors${domain}`;
}

const MonitorEntrySchema = z.object({
    monitor_id: z.string().uuid(),
    section: z.string().max(100).nullable().optional().describe('Optional group heading on the page, e.g. "API"'),
});

export function registerStatusPageTools(server: McpServer, client: SutramXClient): void {
    server.registerTool('sutramx_list_status_pages', {
        title: 'List status pages',
        description: 'List the workspace\'s status pages: id, title, slug, whether public, custom domain and monitor count.',
        inputSchema: { response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ response_format }) => {
        const pages = await client.get<StatusPage[]>('/status/pages/me');
        const markdown = pages.length === 0 ? 'No status pages yet.' : [`# Status pages (${pages.length})`, ...pages.map(pageLine)].join('\n');
        return ok({ total: pages.length, items: pages }, markdown, response_format);
    }));

    server.registerTool('sutramx_get_status_page', {
        title: 'Get status page',
        description: 'One status page with its settings and the monitors shown on it (with sections).',
        inputSchema: { status_page_id: StatusPageIdSchema, response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id, response_format }) => {
        const page = await client.get<StatusPage>(`/status/pages/${status_page_id}`);
        const monitors = (page.monitors || []).map((monitor) => `  - ${monitor.name} (${monitor.id})${monitor.section ? ` · section ${monitor.section}` : ''}`);
        return ok(page as unknown as Record<string, unknown>, [`# ${page.title}`, pageLine(page), monitors.length ? 'Monitors:' : 'No monitors on this page.', ...monitors].join('\n'), response_format);
    }));

    server.registerTool('sutramx_create_status_page', {
        title: 'Create status page',
        description: 'Create a status page (counts against the plan\'s status page limit). Add monitors afterwards with sutramx_set_status_page_monitors.',
        inputSchema: {
            title: z.string().min(1).max(255).describe('Page title, e.g. "Acme status"'),
            description: z.string().max(1000).optional(),
            is_public: z.boolean().optional().describe('Publish the page (default: the backend default)'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, safely(async (args) => {
        const page = await client.post<StatusPage>('/status/pages', args);
        return ok(page as unknown as Record<string, unknown>, `Status page created.\n${pageLine(page)}`);
    }));

    server.registerTool('sutramx_update_status_page', {
        title: 'Update status page',
        description: 'Change a status page\'s settings. Only fields you pass change. Custom domains are managed in the dashboard (owner only).',
        inputSchema: {
            status_page_id: StatusPageIdSchema,
            title: z.string().min(1).max(255).optional(),
            description: z.string().max(1000).nullable().optional(),
            slug: z.string().min(3).max(64).optional().describe('URL slug'),
            is_public: z.boolean().optional(),
            logo_url: z.string().max(2048).nullable().optional().describe('https:// image URL, or null to remove'),
            accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional().describe('Hex colour like #0d9488'),
            show_response_times: z.boolean().optional(),
            hide_powered_by: z.boolean().optional().describe('White-label plans only'),
            other_fields: z.record(z.string(), z.unknown()).optional().describe('Any newer page setting the API accepts, passed through as-is'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id, other_fields, ...fields }) => {
        const patch = { ...(other_fields || {}), ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
        if (Object.keys(patch).length === 0) throw new Error('Pass at least one field to change');
        const page = await client.patch<StatusPage>(`/status/pages/${status_page_id}`, patch);
        return ok(page as unknown as Record<string, unknown>, `Status page updated.\n${pageLine(page)}`);
    }));

    server.registerTool('sutramx_set_status_page_monitors', {
        title: 'Set status page monitors',
        description: 'Replace the list of monitors shown on a status page, in display order, with optional section headings. Send the complete list: monitors left out are removed from the page (not deleted).',
        inputSchema: {
            status_page_id: StatusPageIdSchema,
            monitors: z.array(MonitorEntrySchema).max(500).describe('Ordered list of {monitor_id, section?}'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id, monitors }) => {
        const result = await client.put<Record<string, unknown>>(`/status/pages/${status_page_id}/monitors`, { monitors });
        return ok({ result }, `Status page now shows ${monitors.length} monitor${monitors.length === 1 ? '' : 's'}.`);
    }));

    server.registerTool('sutramx_delete_status_page', {
        title: 'Delete status page',
        description: 'Permanently delete a status page and its subscriber list. Monitors are not affected. Cannot be undone; confirm with the user first.',
        inputSchema: { status_page_id: StatusPageIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id }) => {
        await client.delete(`/status/pages/${status_page_id}`);
        return ok({ deleted: true, status_page_id }, `Deleted status page ${status_page_id}.`);
    }));
}
