import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { SutramXClient } from '../client.js';
import { ok, pct, ResponseFormatSchema, safely, untrusted, when } from '../format.js';
import type { HealthScore, MaintenanceWindow, ReliabilityOverview, SloBurnRate } from '../types.js';

/** The API accepts these windows; anything else silently becomes 30. */
const WINDOW_DAYS = [7, 14, 30, 90] as const;

function minutes(value: number): string {
    if (value < 60) return `${value.toFixed(value < 10 ? 1 : 0)} min`;
    return `${(value / 60).toFixed(1)} h`;
}

function scoreLine(score: HealthScore): string {
    return `| ${untrusted(score.monitor_name, 80).replace(/\|/g, '/')} | ${pct(score.uptime_percentage)} | ${score.incident_count} | ${score.incident_count ? minutes(score.mttr_minutes) : ''} | ${score.total_checks} | ${score.score} |`;
}

function sloLine(slo: SloBurnRate): string {
    const budget = slo.error_budget;
    const state = slo.is_alerting ? 'BURNING FAST' : budget?.exhausted ? 'EXHAUSTED' : 'ok';
    return `- **${untrusted(slo.monitor_name, 120)}** target ${pct(slo.target_percentage)} over ${minutes(slo.slow_window_minutes)}: budget ${budget ? `${budget.remaining_percentage}% left (${minutes(budget.consumed_minutes)} of ${minutes(budget.budget_minutes)} used)` : 'n/a'} · burn rate ${slo.fast_burn_rate}x fast / ${slo.slow_burn_rate}x slow · ${state}`;
}

/** The fields an uptime/SLO report needs, not the full reliability payload (topology, percentiles, baselines). */
export function uptimeReport(overview: ReliabilityOverview, monitorId?: string) {
    const scores = (overview.healthScores || []).filter((score) => !monitorId || score.monitor_id === monitorId);
    const slos = (overview.burnRates || []).filter((slo) => !monitorId || slo.monitor_id === monitorId);
    const totalChecks = scores.reduce((sum, score) => sum + (score.total_checks || 0), 0);
    const weightedUptime = totalChecks > 0
        ? Number((scores.reduce((sum, score) => sum + score.uptime_percentage * (score.total_checks || 0), 0) / totalChecks).toFixed(3))
        : null;
    return {
        window_days: overview.window_days,
        overall_uptime_percentage: weightedUptime,
        incident_count: scores.reduce((sum, score) => sum + (score.incident_count || 0), 0),
        monitors: scores.map((score) => ({
            monitor_id: score.monitor_id,
            monitor_name: score.monitor_name,
            uptime_percentage: score.uptime_percentage,
            incident_count: score.incident_count,
            mttr_minutes: score.mttr_minutes,
            total_checks: score.total_checks,
            health_score: score.score,
        })),
        slos: slos.map((slo) => ({
            slo_id: slo.slo_id,
            monitor_id: slo.monitor_id,
            monitor_name: slo.monitor_name,
            target_percentage: slo.target_percentage,
            window_minutes: slo.slow_window_minutes,
            fast_burn_rate: slo.fast_burn_rate,
            slow_burn_rate: slo.slow_burn_rate,
            is_alerting: slo.is_alerting,
            error_budget: slo.error_budget,
        })),
    };
}

export function registerReliabilityTools(server: McpServer, client: SutramXClient): void {
    server.registerTool('sutramx_uptime_report', {
        title: 'Uptime and SLO report',
        description: `Uptime report over the last 7, 14, 30 or 90 days: per monitor uptime %, incident count, mean time to recovery (MTTR), number of checks and a 0-100 health score, plus every enabled SLO with its error budget (budget/consumed/remaining minutes, exhausted) and burn rates.

Uptime counts checks: degraded (slow) checks count as up. Pass monitor_id for one monitor. SLO targets are set in the dashboard (Growth plan and up); without them "slos" is empty.
Returns {window_days, overall_uptime_percentage, incident_count, monitors:[{monitor_id, monitor_name, uptime_percentage, incident_count, mttr_minutes, total_checks, health_score}], slos:[{slo_id, monitor_id, monitor_name, target_percentage, window_minutes, fast_burn_rate, slow_burn_rate, is_alerting, error_budget}]}.`,
        inputSchema: {
            days: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).default(30).describe(`Report window in days: ${WINDOW_DAYS.join(', ')}`),
            monitor_id: z.string().uuid().optional().describe('Only this monitor (UUID from sutramx_list_monitors)'),
            response_format: ResponseFormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ days, monitor_id, response_format }) => {
        let normalised: ReliabilityOverview;
        if (monitor_id) {
            // One monitor: {monitor, healthScore, burnRate, ...} (null when there is none).
            const one = await client.get<{ healthScore?: HealthScore | null; burnRate?: SloBurnRate | null; }>(`/reliability/monitor/${monitor_id}`, { days });
            normalised = { window_days: days, healthScores: one.healthScore ? [one.healthScore] : [], burnRates: one.burnRate ? [one.burnRate] : [] };
        } else {
            normalised = await client.get<ReliabilityOverview>('/reliability/overview', { days });
        }
        normalised.healthScores ??= [];
        normalised.burnRates ??= [];
        const report = uptimeReport(normalised, monitor_id);
        const markdown = report.monitors.length === 0
            ? `No monitors with data in the last ${report.window_days} days.`
            : [
                `# Uptime report, last ${report.window_days} days`,
                `- overall uptime: ${pct(report.overall_uptime_percentage)} · incidents: ${report.incident_count}`,
                '',
                '| monitor | uptime | incidents | MTTR | checks | health |',
                '|---|---|---|---|---|---|',
                ...normalised.healthScores.filter((score) => !monitor_id || score.monitor_id === monitor_id).map(scoreLine),
                '',
                report.slos.length ? '## SLOs' : 'No SLO targets are set (they are configured in the dashboard).',
                ...normalised.burnRates.filter((slo) => !monitor_id || slo.monitor_id === monitor_id).map(sloLine),
            ].join('\n');
        return ok(report as unknown as Record<string, unknown>, markdown, response_format);
    }));

    server.registerTool('sutramx_list_maintenance_windows', {
        title: 'List maintenance windows',
        description: `Maintenance windows of the workspace, newest start first. While a window is active its monitors (or all monitors, for scope "global") do not alert.

status filters on the effective state (a scheduled window whose time has come is "ongoing"). Returns {total, items:[{id, title, description, status, effectiveStatus, startTime, endTime, timezone, impact, scopeType (global/monitor/group), monitorIds, monitorNames, groupIds, groupNames, recurrence}]}.
Windows can only be created, changed or deleted by a workspace owner in the dashboard: the API refuses API keys for that (403 WORKSPACE_OWNER_REQUIRED).`,
        inputSchema: {
            status: z.enum(['scheduled', 'ongoing', 'completed', 'cancelled']).optional().describe('Only windows in this effective state'),
            response_format: ResponseFormatSchema,
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    }, safely(async ({ status, response_format }) => {
        let items = await client.get<MaintenanceWindow[]>('/maintenance');
        if (status) items = items.filter((window) => (window.effectiveStatus || window.status) === status);
        const scope = (window: MaintenanceWindow) => (window.scopeType === 'monitor'
            ? `monitors ${(window.monitorNames || []).map((name) => untrusted(name, 80)).join(', ')}`
            : window.scopeType === 'group' ? `groups ${(window.groupNames || []).map((name) => untrusted(name, 80)).join(', ')}` : 'all monitors');
        const markdown = items.length === 0
            ? 'No maintenance windows match.'
            : [
                `# Maintenance windows (${items.length})`,
                ...items.map((window) => `- **${untrusted(window.title, 120)}** (${window.id}) ${(window.effectiveStatus || window.status).toUpperCase()} · ${when(window.startTime)} to ${when(window.endTime)}${window.recurrence?.type && window.recurrence.type !== 'none' ? ` · repeats ${window.recurrence.type}` : ''} · ${scope(window)}`),
            ].join('\n');
        return ok({ total: items.length, items } as unknown as Record<string, unknown>, markdown, response_format);
    }));
}
