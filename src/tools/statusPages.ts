import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SutramXClient } from '../client.js';
import { containsTruncated, ok, ResponseFormatSchema, safely, untrusted } from '../format.js';
import { requireDestructive, type ToolPolicy } from '../policy.js';
import type { StatusPage } from '../types.js';

const StatusPageIdSchema = z.string().uuid().describe('Status page id (UUID). Use sutramx_list_status_pages to find it.');

function pageLine(page: StatusPage): string {
    const visibility = page.is_public ? 'public' : 'not public';
    const domain = page.custom_domain ? ` · ${page.custom_domain}` : '';
    return `- **${untrusted(page.title, 120)}** (${page.id}) slug=${page.slug} · ${visibility} · ${page.monitor_count ?? page.monitors?.length ?? 0} monitors${domain}`;
}

const MonitorEntrySchema = z.object({
    monitor_id: z.string().uuid(),
    section: z.string().max(100).nullable().optional().describe('Optional group heading on the page, e.g. "API"'),
});

/** The keys PATCH /status/pages/:id accepts; the API rejects any other key (400). */
export const STATUS_PAGE_SETTINGS = [
    'title', 'description', 'slug', 'is_public', 'logo_url', 'accent_color', 'favicon_url', 'hide_powered_by', 'show_response_times',
] as const;

const HttpsUrlSchema = z.string().max(2048).regex(/^https:\/\//i, 'must be an https:// URL');

const StatusPageSettingsShape = {
    title: z.string().min(1).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    slug: z.string().min(3).max(64).regex(/^[a-z0-9-]+$/, 'lower-case letters, digits and hyphens').optional().describe('URL slug'),
    is_public: z.boolean().optional(),
    logo_url: HttpsUrlSchema.nullable().optional().describe('https:// image URL, or null to remove'),
    accent_color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'hex colour like #0d9488').nullable().optional().describe('Hex colour like #0d9488, or null to remove'),
    favicon_url: HttpsUrlSchema.nullable().optional().describe('https:// favicon URL, or null to remove (Pro plan)'),
    show_response_times: z.boolean().optional(),
    hide_powered_by: z.boolean().optional().describe('Hide the "Powered by SutramX" footer (Pro plan)'),
} satisfies Record<typeof STATUS_PAGE_SETTINGS[number], z.ZodType>;

const StatusPagePatchSchema = z.object(StatusPageSettingsShape).strict();

/**
 * The PATCH body for sutramx_update_status_page: named fields over
 * other_fields, unknown keys refused with the list of accepted ones (the API
 * would answer 400 for them), values checked like the named fields.
 */
export function statusPagePatch(fields: Record<string, unknown>, otherFields?: Record<string, unknown>): Record<string, unknown> {
    const extra = otherFields || {};
    const unknown = Object.keys(extra).filter((name) => !(STATUS_PAGE_SETTINGS as readonly string[]).includes(name));
    if (unknown.length) {
        throw new Error(`Unknown status page setting${unknown.length === 1 ? '' : 's'}: ${unknown.map((name) => JSON.stringify(name.slice(0, 64))).join(', ')}. The API accepts only: ${STATUS_PAGE_SETTINGS.join(', ')}.`);
    }
    const merged = { ...extra, ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) };
    const parsed = StatusPagePatchSchema.safeParse(merged);
    if (!parsed.success) {
        throw new Error(`Invalid status page settings: ${parsed.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')}`);
    }
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, value]) => value !== undefined));
    if (Object.keys(patch).length === 0) throw new Error('Pass at least one field to change');
    return patch;
}

/** Settings whose change is visible to the public (publish/unpublish, page URL). */
export const PUBLIC_IMPACT_SETTINGS = ['is_public', 'slug'] as const;

const ListOutputShape = {
    total: z.number(),
    items: z.array(z.record(z.string(), z.unknown())),
    truncated: z.boolean().optional(),
};

export function registerStatusPageTools(server: McpServer, client: SutramXClient, policy: ToolPolicy): void {
    server.registerTool('sutramx_list_status_pages', {
        title: 'List status pages',
        description: 'List the workspace\'s status pages: id, title, slug, whether public, custom domain and monitor count.',
        inputSchema: { response_format: ResponseFormatSchema },
        outputSchema: ListOutputShape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safely(async ({ response_format }) => {
        const pages = await client.get<StatusPage[]>('/status/pages/me');
        const markdown = pages.length === 0 ? 'No status pages yet.' : [`# Status pages (${pages.length})`, ...pages.map(pageLine)].join('\n');
        return ok({ total: pages.length, items: pages }, markdown, response_format);
    }));

    server.registerTool('sutramx_get_status_page', {
        title: 'Get status page',
        description: 'One status page with its settings and the monitors shown on it (with sections).',
        inputSchema: { status_page_id: StatusPageIdSchema, response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safely(async ({ status_page_id, response_format }) => {
        const page = await client.get<StatusPage>(`/status/pages/${status_page_id}`);
        const monitors = (page.monitors || []).map((monitor) => `  - ${untrusted(monitor.name, 120)} (${monitor.id})${monitor.section ? ` · section ${untrusted(monitor.section, 100)}` : ''}`);
        return ok(page as unknown as Record<string, unknown>, [`# ${untrusted(page.title, 255)}`, pageLine(page), monitors.length ? 'Monitors:' : 'No monitors on this page.', ...monitors].join('\n'), response_format);
    }));

    server.registerTool('sutramx_create_status_page', {
        title: 'Create status page',
        description: policy.allowDestructive
            ? 'Create a status page (counts against the plan\'s status page limit). It is public unless is_public=false. Add monitors afterwards with sutramx_set_status_page_monitors.'
            : 'Create a status page (counts against the plan\'s status page limit). On this server pages are created NOT public: publishing (is_public=true) is disabled unless the operator enables destructive mode; the user can publish it in the dashboard.',
        inputSchema: {
            title: z.string().min(1).max(255).describe('Page title, e.g. "Acme status"'),
            description: z.string().max(1000).optional(),
            is_public: z.boolean().optional().describe(policy.allowDestructive ? 'Publish the page (default true)' : 'Must be false or omitted on this server (publishing is disabled)'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: policy.allowDestructive },
    }, safely(async (args) => {
        if (args.is_public === true) requireDestructive(policy, 'Publishing a status page (is_public=true)');
        // The API publishes new pages by default; outside destructive mode never let it.
        const body = policy.allowDestructive ? args : { ...args, is_public: false };
        const page = await client.post<StatusPage>('/status/pages', body);
        return ok(page as unknown as Record<string, unknown>, `Status page created.\n${pageLine(page)}`);
    }));

    server.registerTool('sutramx_update_status_page', {
        title: 'Update status page',
        description: `Change a status page's settings. Only fields you pass change.

Settings the API accepts: ${STATUS_PAGE_SETTINGS.join(', ')}. Any other key is rejected before the API is called. hide_powered_by and favicon_url need the Pro plan (white-label); a 403 WHITE_LABEL_NOT_ENTITLED means the plan does not include it.
Monitors on the page are changed with sutramx_set_status_page_monitors. Custom domains are managed in the dashboard (owner only).${policy.allowDestructive ? '' : `
On this server ${PUBLIC_IMPACT_SETTINGS.join(' and ')} cannot be changed (publishing, unpublishing or moving a page needs destructive mode, which only the operator can enable), and a page that is public cannot be changed at all (everything on it is visible to the public). Pages that are not public can be edited; the user can change public pages in the dashboard.`}`,
        inputSchema: {
            status_page_id: StatusPageIdSchema,
            ...StatusPageSettingsShape,
            other_fields: z.record(z.string(), z.unknown()).optional().describe(`The same settings as an object, for clients that send them nested. Only these keys are accepted: ${STATUS_PAGE_SETTINGS.join(', ')}; named fields win.`),
        },
        // Can change a public page (or publish, unpublish or move one) only in destructive mode.
        annotations: { readOnlyHint: false, destructiveHint: policy.allowDestructive, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id, other_fields, ...fields }) => {
        const patch = statusPagePatch(fields, other_fields);
        const publicChanges = PUBLIC_IMPACT_SETTINGS.filter((name) => name in patch);
        if (publicChanges.length) requireDestructive(policy, `Changing ${publicChanges.join(' and ')} of a status page`);
        if (containsTruncated(patch)) throw new Error('A value ends in [TRUNCATED]: it was cut short in an earlier result. Send the full value.');
        if (!policy.allowDestructive) {
            // Every setting of a public page is visible to the public. Fail
            // closed: only a page the API reports as not public is editable.
            const current = await client.get<StatusPage>(`/status/pages/${status_page_id}`);
            if (current.is_public !== false) requireDestructive(policy, 'Changing a public status page');
        }
        const page = await client.patch<StatusPage>(`/status/pages/${status_page_id}`, patch);
        return ok(page as unknown as Record<string, unknown>, `Status page updated.\n${pageLine(page)}`);
    }));

    server.registerTool('sutramx_set_status_page_monitors', {
        title: 'Set status page monitors',
        description: 'Replace the list of monitors shown on a (possibly public) status page, in display order, with optional section headings. Send the complete list: monitors left out are removed from the page (not deleted). Confirm with the user first. Only available when the operator enabled destructive mode (SUTRAMX_ALLOW_DESTRUCTIVE).',
        inputSchema: {
            status_page_id: StatusPageIdSchema,
            monitors: z.array(MonitorEntrySchema).max(500).describe('Ordered list of {monitor_id, section?}. An empty list is refused unless remove_all is true'),
            remove_all: z.boolean().default(false).describe('Set true (only after the user confirmed) to send an empty list and take every monitor off the page'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id, monitors, remove_all }) => {
        // Belt and braces: the tool is only registered in destructive mode.
        requireDestructive(policy, 'Replacing the monitors of a status page');
        if (monitors.length === 0 && !remove_all) throw new Error('Refused: an empty list would remove every monitor from the page. Pass remove_all=true only if the user confirmed exactly that.');
        const result = await client.put<Record<string, unknown>>(`/status/pages/${status_page_id}/monitors`, { monitors });
        return ok({ result }, `Status page now shows ${monitors.length} monitor${monitors.length === 1 ? '' : 's'}.`);
    }));

    server.registerTool('sutramx_delete_status_page', {
        title: 'Delete status page',
        description: 'Permanently delete a status page and its subscriber list. Monitors are not affected. Cannot be undone; confirm with the user first. Only available when the operator enabled destructive mode (SUTRAMX_ALLOW_DESTRUCTIVE).',
        inputSchema: { status_page_id: StatusPageIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status_page_id }) => {
        await client.delete(`/status/pages/${status_page_id}`);
        return ok({ deleted: true, status_page_id }, `Deleted status page ${status_page_id}.`);
    }));
}
