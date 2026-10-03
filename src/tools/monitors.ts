import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SutramXClient } from '../client.js';
import { containsRedacted, hasInventedRedacted, ok, paginate, pct, redactSecrets, ResponseFormatSchema, restoreRedacted, safely, untrusted, when } from '../format.js';
import type { CheckPage, Monitor, MonitorSummary, RunCheckResult } from '../types.js';

const STATUSES = ['up', 'down', 'degraded', 'paused', 'pending', 'maintenance'] as const;
/** Monitor types POST /monitors accepts. */
export const MONITOR_TYPES = ['http', 'api', 'ping', 'port', 'udp', 'dns', 'multistep', 'cron'] as const;

const MonitorIdSchema = z.string().uuid().describe('Monitor id (UUID). Use sutramx_list_monitors to find it.');
const MonitorKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/, 'letters, digits and . _ : / - (1-128 characters, starting with a letter or digit)');
const RegionCodeSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,19}$/, 'lower-case region code, e.g. "fra1"');
/** ISO-8601 timestamps only: these go into query strings. */
export const IsoTimeSchema = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}([T ][0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/, 'ISO-8601 time, e.g. 2026-01-31T12:00:00Z');

const MonitorFieldsShape = {
    name: z.string().min(1).max(255).describe('Display name, e.g. "Checkout API"'),
    url: z.string().max(2048).optional().describe('Target URL, required for http/api monitors (https://...). Other types take their target from config: ping/port/udp config.host, dns config.hostname, multistep the URL of each step.'),
    interval_seconds: z.number().int().min(15).max(900).optional().describe('Seconds between checks (15-900). Plans have a minimum; omit for the plan default.'),
    config: z.record(z.string(), z.unknown()).optional().describe('Type-specific settings, e.g. {"timeout": 10000, "expected_status_codes": [200], "keyword": "ok", "headers": {...}}; ping monitors need {"host": "example.com"}; port/udp monitors {"host": "db.example.com", "port": 5432}; dns monitors {"hostname": "example.com", "record_type": "A"} (record_type A, AAAA, CNAME, MX, TXT or NS; alerts on any change, or set "dns_mode": "expected" with "expected_values": [...]); multistep monitors {"steps": [{"name": "Login", "method": "POST", "url": "https://api.example.com/login", "expected_status_codes": [200]}, ...]} (write-only secrets go in "secrets": {"NAME": "value"} and are used as {{secrets.NAME}}); cron monitors {"cron_expression": "*/5 * * * *"}.'),
    tags: z.array(z.string().min(1).max(32).regex(/^[^\u0000-\u001f]+$/)).max(20).optional().describe('Labels, lower-cased (e.g. ["prod", "api"])'),
    regions: z.array(RegionCodeSchema).min(1).max(50).optional().describe('Probe location codes to check from (e.g. ["fra1", "usa-az-probe"]). See sutramx_list_regions. Omit for the plan default.'),
};

export function monitorLine(monitor: Monitor): string {
    const status = monitor.current_status || (monitor.is_active ? 'pending' : 'paused');
    const target = monitor.url ? ` ${monitor.url}` : '';
    const key = monitor.external_id ? ` key=${monitor.external_id}` : '';
    return `- **${untrusted(monitor.name, 120)}** (${monitor.id}) [${monitor.type}] ${status.toUpperCase()}${target} · every ${monitor.interval_seconds}s · 24h ${pct(monitor.uptime_24h)}${key}`;
}

function monitorMarkdown(monitor: Monitor): string {
    const lines = [
        `# ${untrusted(monitor.name, 255)}`,
        `- id: ${monitor.id}${monitor.external_id ? ` (key: ${monitor.external_id})` : ''}`,
        `- type: ${monitor.type}${monitor.url ? ` · target: ${monitor.url}` : ''}`,
        `- status: ${monitor.current_status ?? (monitor.is_active ? 'active' : 'paused')}${monitor.open_incident ? ` · open incident ${monitor.open_incident.id} since ${when(monitor.open_incident.started_at)}` : ''}`,
        `- interval: ${monitor.interval_seconds}s · regions: ${(monitor.effective_regions || monitor.probe_regions || []).join(', ') || 'plan default'}`,
        `- uptime: 24h ${pct(monitor.uptime_24h)} · 30d ${pct(monitor.uptime_30d)}`,
        `- last check: ${when(monitor.last_checked_at)}${monitor.last_status ? ` (${monitor.last_status}${monitor.last_response_time_ms != null ? `, ${monitor.last_response_time_ms} ms` : ''})` : ''}${monitor.last_error ? ` · error: ${untrusted(monitor.last_error)}` : ''}`,
    ];
    if (monitor.tags?.length) lines.push(`- tags: ${monitor.tags.join(', ')}`);
    if (monitor.heartbeat_url) lines.push(`- heartbeat URL: ${monitor.heartbeat_url}`);
    return lines.join('\n');
}

export function registerMonitorTools(server: McpServer, client: SutramXClient): void {
    server.registerTool('sutramx_list_monitors', {
        title: 'List monitors',
        description: `List the workspace's monitors with their live status and uptime.

Filters are applied in this order: tag (server side), then status and search (name/URL substring), then offset/limit.
Returns {total, count, offset, has_more, next_offset?, items: Monitor[]} where each Monitor has id, name, type, url, interval_seconds, is_active, current_status (up/down/degraded/paused/pending/maintenance), uptime_24h, uptime_30d, last_checked_at, last_error, open_incident, tags, external_id.

Use sutramx_get_monitor for one monitor's full details and sutramx_get_check_results for its check history.`,
        inputSchema: {
            status: z.enum(STATUSES).optional().describe('Only monitors currently in this status'),
            tag: z.string().max(32).optional().describe('Only monitors with this tag'),
            search: z.string().max(200).optional().describe('Case-insensitive substring of name or URL'),
            limit: z.number().int().min(1).max(200).default(50).describe('Max monitors to return'),
            offset: z.number().int().min(0).default(0).describe('Monitors to skip (pagination)'),
            response_format: ResponseFormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status, tag, search, limit, offset, response_format }) => {
        let monitors = redactSecrets(await client.get<Monitor[]>('/monitors', { tag }));
        if (status) monitors = monitors.filter((monitor) => monitor.current_status === status);
        if (search) {
            const needle = search.toLowerCase();
            monitors = monitors.filter((monitor) => monitor.name.toLowerCase().includes(needle) || (monitor.url || '').toLowerCase().includes(needle));
        }
        const page = paginate(monitors, offset, limit);
        const markdown = page.count === 0
            ? 'No monitors match.'
            : [`# Monitors (${page.count} of ${page.total})`, ...page.items.map(monitorLine), page.has_more ? `\nMore available: offset=${page.next_offset}` : ''].join('\n');
        return ok(page as unknown as Record<string, unknown>, markdown, response_format);
    }));

    server.registerTool('sutramx_monitor_summary', {
        title: 'Monitor status summary',
        description: 'Counts of monitors by status (up, down, degraded, paused, pending, maintenance), open incidents, workspace 24h uptime and mean time between failures. A quick health overview; no arguments.',
        inputSchema: { response_format: ResponseFormatSchema },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ response_format }) => {
        const summary = await client.get<MonitorSummary>('/monitors/summary');
        const markdown = [
            '# Workspace health',
            `- monitors: ${summary.total} (${summary.active} active)`,
            `- up ${summary.up} · down ${summary.down} · degraded ${summary.degraded} · paused ${summary.paused} · pending ${summary.pending} · maintenance ${summary.maintenance}`,
            `- open incidents: ${summary.open_incidents}`,
            `- 24h uptime: ${pct(summary.uptime_24h)} · last incident: ${when(summary.last_incident_at)}`,
        ].join('\n');
        return ok(summary as unknown as Record<string, unknown>, markdown, response_format);
    }));

    server.registerTool('sutramx_get_monitor', {
        title: 'Get monitor',
        description: 'Full details of one monitor by id (or by its monitoring-as-code key): config, regions, live status, uptime, last check and any open incident.',
        inputSchema: {
            monitor_id: MonitorIdSchema.optional(),
            key: MonitorKeySchema.optional().describe('The monitor key set by sutramx.yml / Terraform, instead of monitor_id'),
            response_format: ResponseFormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id, key, response_format }) => {
        if (!monitor_id && !key) throw new Error('Pass monitor_id or key');
        const monitor = redactSecrets(monitor_id
            ? await client.get<Monitor>(`/monitors/${monitor_id}`)
            : await client.get<Monitor>(`/automation/monitors/${encodeURIComponent(key!)}`));
        return ok(monitor as unknown as Record<string, unknown>, monitorMarkdown(monitor), response_format);
    }));

    server.registerTool('sutramx_create_monitor', {
        title: 'Create monitor',
        description: `Create a monitor. It is scheduled immediately.

Pass "key" to make the call idempotent: a monitor with that key is created once and updated on later calls (same as sutramx.yml / Terraform). Without a key every call creates a new monitor.
Plan limits (monitor count, minimum interval, locations) are enforced; a 403 ENTITLEMENT_LIMIT_REACHED means the plan is full. dns and multistep monitors need a plan that includes them (403 FEATURE_NOT_AVAILABLE otherwise).

Examples: {"name":"Homepage","url":"https://example.com"}; {"name":"Nightly backup","type":"cron","config":{"cron_expression":"0 2 * * *"}}; {"name":"Postgres","type":"port","config":{"host":"db.example.com","port":5432}}; {"name":"MX records","type":"dns","config":{"hostname":"example.com","record_type":"MX"}}`,
        inputSchema: {
            type: z.string().min(2).max(32).default('http').describe(`Monitor type: ${MONITOR_TYPES.join(', ')} (default http)`),
            ...MonitorFieldsShape,
            key: MonitorKeySchema.optional().describe('Optional stable key for idempotent create-or-update'),
            paused: z.boolean().optional().describe('Create it paused'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, safely(async ({ key, paused, ...fields }) => {
        if (containsRedacted(fields)) throw new Error('Replace [REDACTED] with real values when creating a monitor (or use sutramx_update_monitor to keep stored ones).');
        if (key) {
            const result = redactSecrets(await client.put<{ action: string; monitor: Monitor; }>(`/automation/monitors/${encodeURIComponent(key)}`, { ...fields, ...(paused !== undefined ? { paused } : {}) }));
            return ok(result as unknown as Record<string, unknown>, `Monitor ${result.action}.\n\n${monitorMarkdown(result.monitor)}`);
        }
        let monitor = await client.post<Monitor>('/monitors', fields);
        if (paused) monitor = await client.post<Monitor>(`/monitors/${encodeURIComponent(monitor.id)}/pause`);
        monitor = redactSecrets(monitor);
        return ok({ action: 'created', monitor } as unknown as Record<string, unknown>, `Monitor created.\n\n${monitorMarkdown(monitor)}`);
    }));

    server.registerTool('sutramx_update_monitor', {
        title: 'Update monitor',
        description: 'Change a monitor. Only the fields you pass change. "config" replaces the whole config object, so read the monitor first and send the merged config. "regions" replaces the probe locations. The type cannot be changed.',
        inputSchema: {
            monitor_id: MonitorIdSchema,
            name: MonitorFieldsShape.name.optional(),
            url: MonitorFieldsShape.url,
            interval_seconds: MonitorFieldsShape.interval_seconds,
            config: MonitorFieldsShape.config,
            tags: MonitorFieldsShape.tags,
            regions: MonitorFieldsShape.regions,
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id, regions, ...fields }) => {
        const changes: Record<string, unknown> = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
        if (Object.keys(changes).length === 0 && !regions) throw new Error('Pass at least one field to change');
        if (containsRedacted(changes)) {
            // The agent read a redacted monitor and sent it back: keep the stored credentials.
            // Values the API itself returns masked stay [REDACTED]; the API keeps them.
            const current = await client.get<Monitor>(`/monitors/${monitor_id}`);
            for (const field of Object.keys(changes)) changes[field] = restoreRedacted(changes[field], current[field]);
            if (Object.keys(changes).some((field) => hasInventedRedacted(changes[field], current[field]))) {
                throw new Error('[REDACTED] can only stand for a value that is already stored at the same place in the monitor.');
            }
        }
        let monitor: Monitor | undefined;
        if (Object.keys(changes).length > 0) monitor = await client.put<Monitor>(`/monitors/${monitor_id}`, changes);
        if (regions) {
            await client.put(`/monitors/${monitor_id}/regions`, { regions });
            monitor = await client.get<Monitor>(`/monitors/${monitor_id}`);
        }
        monitor = redactSecrets(monitor!);
        return ok({ monitor } as unknown as Record<string, unknown>, `Monitor updated.\n\n${monitorMarkdown(monitor)}`);
    }));

    server.registerTool('sutramx_pause_monitor', {
        title: 'Pause monitor',
        description: 'Stop checking a monitor (no checks, no alerts) until it is resumed. History is kept.',
        inputSchema: { monitor_id: MonitorIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id }) => {
        const monitor = redactSecrets(await client.post<Monitor>(`/monitors/${monitor_id}/pause`));
        return ok({ monitor } as unknown as Record<string, unknown>, `Paused ${untrusted(monitor.name, 120)} (${monitor.id}).`);
    }));

    server.registerTool('sutramx_resume_monitor', {
        title: 'Resume monitor',
        description: 'Resume a paused monitor; it is checked right away. Fails with 403 if the plan\'s active-monitor limit is reached.',
        inputSchema: { monitor_id: MonitorIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id }) => {
        const monitor = redactSecrets(await client.post<Monitor>(`/monitors/${monitor_id}/resume`));
        return ok({ monitor } as unknown as Record<string, unknown>, `Resumed ${untrusted(monitor.name, 120)} (${monitor.id}).`);
    }));

    server.registerTool('sutramx_delete_monitor', {
        title: 'Delete monitor',
        description: 'Permanently delete a monitor with its check history and incidents. Cannot be undone; confirm with the user first. Use sutramx_pause_monitor to stop checks temporarily. Only available when the user enabled destructive tools (SUTRAMX_ALLOW_DESTRUCTIVE).',
        inputSchema: { monitor_id: MonitorIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id }) => {
        await client.delete(`/monitors/${monitor_id}`);
        return ok({ deleted: true, monitor_id }, `Deleted monitor ${monitor_id}.`);
    }));

    server.registerTool('sutramx_run_check', {
        title: 'Run a check now',
        description: 'Run one real check of a monitor right now from one region and record it like a scheduled check. Returns status, HTTP status code, response time and error. Refused (409) for paused monitors. Rate limited to 30 per 5 minutes.',
        inputSchema: { monitor_id: MonitorIdSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    }, safely(async ({ monitor_id }) => {
        const result = await client.post<RunCheckResult>(`/monitors/${monitor_id}/run-check`);
        const markdown = `Check from ${result.region}: **${result.status.toUpperCase()}** in ${result.response_time_ms} ms${result.status_code ? ` (HTTP ${result.status_code})` : ''}${result.error_message ? `\nError: ${untrusted(result.error_message)}` : ''}`;
        return ok(result as unknown as Record<string, unknown>, markdown);
    }));

    server.registerTool('sutramx_get_check_results', {
        title: 'Get check results',
        description: `Check history of one monitor, newest first: one row per check per region with status, response time, HTTP status, error type and message.

Paginate with "before" = next_before from the previous page. status "problem" returns every non-up check. Returns {items:[{id, checked_at, region, status, response_time_ms, status_code, error_type, error_message}], next_before}.`,
        inputSchema: {
            monitor_id: MonitorIdSchema,
            limit: z.number().int().min(1).max(500).default(50).describe('Rows to return (1-500)'),
            before: IsoTimeSchema.optional().describe('ISO-8601 cursor: only checks before this time (next_before of the previous page)'),
            region: RegionCodeSchema.optional().describe('Only this region code, e.g. "fra1"'),
            status: z.enum(['up', 'down', 'degraded', 'problem']).optional().describe('Only checks with this status'),
            response_format: ResponseFormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ monitor_id, limit, before, region, status, response_format }) => {
        const page = await client.get<CheckPage>(`/monitors/${monitor_id}/checks`, { limit, before, region, status });
        const rows = page.items || [];
        const markdown = rows.length === 0
            ? 'No checks match.'
            : [
                `# Checks (${rows.length})`,
                '| time | region | status | ms | HTTP | error |',
                '|---|---|---|---|---|---|',
                ...rows.map((row) => `| ${when(row.checked_at)} | ${String(row.region ?? '').replace(/[^a-z0-9-]/gi, '')} | ${row.status} | ${row.response_time_ms ?? ''} | ${row.status_code ?? ''} | ${row.error_type || row.error_message ? untrusted(row.error_type || row.error_message, 80).replace(/\|/g, '/') : ''} |`),
                page.next_before ? `\nOlder checks: before=${page.next_before}` : '',
            ].join('\n');
        return ok(page as unknown as Record<string, unknown>, markdown, response_format);
    }));
}
