import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SutramXClient } from '../client.js';
import { ok, ResponseFormatSchema, safely } from '../format.js';
import type { Region } from '../types.js';

export function registerAccountTools(server: McpServer, client: SutramXClient): void {
    server.registerTool('sutramx_whoami', {
        title: 'Account and plan',
        description: 'The workspace this API key acts on, its plan and limits (monitors, minimum interval, locations per monitor, status pages) whether the key is read-only and whether it may manage alert channels. Call this first when unsure what the plan allows.',
        inputSchema: { response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safely(async ({ response_format }) => {
        const me = await client.get<Record<string, any>>('/automation/whoami');
        const limits = me.limits || {};
        const markdown = [
            `# Workspace ${me.workspace_id}`,
            `- plan: ${me.plan} (${me.market})`,
            `- monitors: ${limits.monitors ?? 'unlimited'} · minimum interval ${limits.min_interval_seconds}s · locations per monitor ${limits.probe_locations ?? 'all'} · status pages ${limits.status_pages ?? 'unlimited'}`,
            `- credential: ${me.auth_type}${me.api_key_access ? ` (${me.api_key_access} access)` : ''} · can manage alert channels: ${me.can_manage_alert_channels ? 'yes' : 'no'}`,
            ...(me.read_only ? ['- read-only: this key can only read; every change (create, update, pause, delete, acknowledge, resolve, notes) is refused with READ_ONLY_ACCESS'] : []),
        ].join('\n');
        return ok(me, markdown, response_format);
    }));

    server.registerTool('sutramx_list_regions', {
        title: 'List probe regions',
        description: 'Every SutramX probe location: code (use in a monitor\'s "regions"), city, country, continent and whether it is online. Which codes a monitor may use depends on the plan (see sutramx_whoami).',
        inputSchema: { response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, safely(async ({ response_format }) => {
        const data = await client.get<{ regions: Region[]; }>('/catalog/regions', undefined, true);
        const regions = data.regions || [];
        const markdown = [`# Probe regions (${regions.length})`, ...regions.map((region) => `- \`${region.code}\` ${region.name}${region.country ? `, ${region.country}` : ''}${region.online === false ? ' (offline)' : ''}`)].join('\n');
        return ok({ total: regions.length, regions }, markdown, response_format);
    }));
}
