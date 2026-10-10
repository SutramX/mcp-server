/** Response shapes of the SutramX API used by the tools (fields the tools read). */

export interface Monitor {
    id: string;
    name: string;
    type: string;
    url?: string | null;
    interval_seconds: number;
    is_active: boolean;
    config: Record<string, unknown>;
    tags?: string[];
    probe_regions?: string[] | null;
    effective_regions?: string[] | null;
    external_id?: string | null;
    current_status?: string;
    last_status?: string | null;
    last_checked_at?: string | null;
    last_response_time_ms?: number | null;
    last_error?: string | null;
    open_incident?: { id: string; started_at: string | null; } | null;
    uptime_24h?: number | null;
    uptime_30d?: number | null;
    heartbeat_url?: string | null;
    [key: string]: unknown;
}

export interface MonitorSummary {
    total: number;
    active: number;
    up: number;
    down: number;
    degraded: number;
    paused: number;
    pending: number;
    maintenance: number;
    open_incidents: number;
    uptime_24h: number | null;
    last_incident_at: string | null;
    [key: string]: unknown;
}

export interface RunCheckResult {
    status: string;
    status_code: number | null;
    response_time_ms: number;
    error_message: string | null;
    error_type: string | null;
    region: string;
    checked_at: string;
    /** Type-specific check details (e.g. kind 'mcp'). */
    details?: unknown;
}

export interface CheckRow {
    id: string;
    checked_at: string;
    region: string;
    status: string;
    status_code: number | null;
    response_time_ms: number | null;
    error_type: string | null;
    error_message: string | null;
}

export interface CheckPage {
    items: CheckRow[];
    next_before: string | null;
    [key: string]: unknown;
}

export interface Incident {
    id: string;
    monitor_id: string;
    monitor_name: string;
    monitor_url: string | null;
    started_at: string;
    resolved_at: string | null;
    duration_seconds: number | null;
    alert_suppressed: boolean;
    is_flapping: boolean;
    confirming_region_names?: string[];
    acknowledged_at: string | null;
    acknowledged_by_name: string | null;
    [key: string]: unknown;
}

export interface IncidentList {
    items: Incident[];
    total: number;
    page: number;
    page_size: number;
    counts: Record<string, number>;
}

export interface StatusPage {
    id: string;
    title: string;
    slug: string;
    description?: string | null;
    is_public: boolean;
    custom_domain?: string | null;
    monitor_count?: number;
    monitors?: Array<{ id: string; name: string; section: string | null; }>;
    [key: string]: unknown;
}

export interface Region {
    code: string;
    name: string;
    city?: string | null;
    country?: string | null;
    continent?: string | null;
    online?: boolean;
}

export interface HealthScore {
    monitor_id: string;
    monitor_name: string;
    score: number;
    uptime_percentage: number;
    incident_count: number;
    mttr_minutes: number;
    flakiness_index?: number;
    total_checks: number;
    [key: string]: unknown;
}

export interface SloBurnRate {
    slo_id: string;
    monitor_id: string;
    monitor_name: string;
    target_percentage: number;
    fast_window_minutes: number;
    slow_window_minutes: number;
    fast_burn_rate: number;
    slow_burn_rate: number;
    is_alerting: boolean;
    sample_count: number;
    error_budget?: {
        budget_minutes: number;
        consumed_minutes: number;
        remaining_minutes: number;
        remaining_percentage: number;
        exhausted: boolean;
    };
    [key: string]: unknown;
}

/** GET /reliability/overview (fields the uptime report reads). */
export interface ReliabilityOverview {
    window_days: number;
    healthScores: HealthScore[];
    burnRates: SloBurnRate[];
    [key: string]: unknown;
}

export interface MaintenanceWindow {
    id: string;
    title: string;
    description?: string;
    status: string;
    effectiveStatus?: string;
    startTime: string | null;
    endTime: string | null;
    timezone?: string;
    impact?: string;
    scopeType?: string;
    monitorIds?: string[];
    monitorNames?: string[];
    groupIds?: string[];
    groupNames?: string[];
    recurrence?: { type?: string; weekdays?: number[]; until?: string | null; };
    [key: string]: unknown;
}

/** "Why this alert": GET /incidents/:id/explanation and GET /monitors/:id/explanation (fields the tools read). */
export interface ExplanationVote {
    region: string;
    region_name: string;
    status: 'up' | 'down' | 'blocked' | 'inconclusive' | 'unknown';
    stored_status?: string | null;
    checked_at: string | null;
    error_type: string | null;
    failure_class: string | null;
    http_status: number | null;
    message: string | null;
    timings: { total_ms?: number; dns_ms?: number; connect_ms?: number; tls_ms?: number; ttfb_ms?: number; } | null;
    confirming: boolean;
}

export interface ExplanationContributor {
    kind: string;
    title: string;
    detail: string;
    severity: 'info' | 'likely_cause';
    source: string;
    data?: unknown;
}

export interface IncidentExplanation {
    version: number;
    subject: 'incident' | 'monitor';
    state: 'ongoing' | 'resolved' | 'failing_unconfirmed' | 'healthy' | 'no_data';
    monitor: { id: string; name: string; type: string; url: string | null; };
    incident_id: string | null;
    opened_at: string | null;
    resolved_at: string | null;
    evaluated_at: string;
    verdict: string;
    fault: 'yours' | 'external' | 'checker' | 'unknown';
    fault_reason: string;
    is_flapping: boolean;
    votes: ExplanationVote[];
    quorum: {
        rule: string;
        required: number | null;
        considered: number | null;
        agreeing: number;
        met: boolean;
        abstaining: string[];
        reduced_coverage: { missing_regions: string[]; usual_quorum: number | null; } | null;
        confirmation: { state: 'confirmed' | 'refuted' | 'pending' | 'none'; summary: string; checks: unknown[]; } | null;
    };
    failure: { class: string | null; label: string; scope: string; failing_regions: string[]; passing_regions: string[]; };
    alert: { notified: boolean; status: string; reason: string | null; detail: string; delivery: unknown; } | null;
    contributors: ExplanationContributor[];
    [key: string]: unknown;
}

export interface FlakinessWindow {
    days: number;
    score: number | null;
    level: string;
    label: string;
    total_checks: number;
    reasons: Array<{ kind: string; label: string; detail: string; count: number; points: number; }>;
}

/** GET /monitors/:id/flakiness. */
export interface MonitorFlakiness {
    monitor_id: string;
    computed_at: string;
    short_incident_seconds: number;
    windows: { '7d': FlakinessWindow; '30d': FlakinessWindow; };
}
