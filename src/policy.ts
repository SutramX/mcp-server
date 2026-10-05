import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/**
 * What the tools of one server instance may do. AI agents can be steered by
 * text they read (prompt injection), so the operator, not the agent, decides:
 *
 *  readOnly          only tools annotated readOnlyHint are registered.
 *  allowDestructive  tools annotated destructiveHint (permanent deletes,
 *                    removing monitors from status pages) are registered,
 *                    and public-impacting arguments (publishing a page,
 *                    changing its slug, public incident updates) are
 *                    accepted, only when this is true. Off by default.
 *
 * stdio: SUTRAMX_READ_ONLY=true / SUTRAMX_ALLOW_DESTRUCTIVE=true.
 * HTTP:  the same env (server-wide). Per request, X-SutramX-Read-Only: true
 *        always narrows; X-SutramX-Allow-Destructive: true is honoured only
 *        when the operator also set SUTRAMX_HTTP_ALLOW_DESTRUCTIVE_HEADER=true.
 * Tool arguments can never change the policy.
 */
export interface ToolPolicy {
    readOnly: boolean;
    allowDestructive: boolean;
}

export const DEFAULT_POLICY: ToolPolicy = { readOnly: false, allowDestructive: false };

export function truthy(value: string | string[] | undefined): boolean {
    const text = Array.isArray(value) ? value[0] : value;
    return /^(1|true|yes|on)$/i.test((text || '').trim());
}

export function policyFromEnv(env: NodeJS.ProcessEnv = process.env): ToolPolicy {
    return { readOnly: truthy(env.SUTRAMX_READ_ONLY), allowDestructive: truthy(env.SUTRAMX_ALLOW_DESTRUCTIVE) };
}

/**
 * The policy of one HTTP request: headers may narrow to read-only; they may
 * only opt into destructive tools when the operator allowed that by env.
 */
export function policyForRequest(serverPolicy: ToolPolicy, headers: Record<string, string | string[] | undefined>, env: NodeJS.ProcessEnv = process.env): ToolPolicy {
    const headerOptIn = truthy(env.SUTRAMX_HTTP_ALLOW_DESTRUCTIVE_HEADER) && truthy(headers['x-sutramx-allow-destructive']);
    return {
        readOnly: serverPolicy.readOnly || truthy(headers['x-sutramx-read-only']),
        allowDestructive: serverPolicy.allowDestructive || headerOptIn,
    };
}

/** Thrown (and shown to the agent) when an argument needs destructive mode. */
export class DestructiveModeRequired extends Error {
    constructor(what: string) {
        super(`Refused: ${what} is disabled on this server. Only the server operator can enable it (SUTRAMX_ALLOW_DESTRUCTIVE=true); tool arguments cannot. Tell the user instead of retrying.`);
        this.name = 'DestructiveModeRequired';
    }
}

export function requireDestructive(policy: ToolPolicy, what: string): void {
    if (!policy.allowDestructive || policy.readOnly) throw new DestructiveModeRequired(what);
}

interface Annotations {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
}

export function toolAllowed(annotations: Annotations | undefined, policy: ToolPolicy): boolean {
    if (annotations?.readOnlyHint === true) return true;
    if (policy.readOnly) return false;
    if (annotations?.destructiveHint === true) return policy.allowDestructive;
    return true;
}

/**
 * Sliding-window limits on the tools that change data, per session (stdio:
 * the process; HTTP: the API key, see index.ts). Stops a steered agent from
 * pausing or rewriting a whole workspace in a loop; the API has its own
 * per-key limits on top.
 */
export interface MutationLimits {
    /** Changes of any kind per minute. */
    perMinute: number;
    /** Changes of any kind per hour. */
    perHour: number;
    /** Pauses per hour (pausing silences alerting), when destructive mode is off. */
    pausesPerHour: number;
}

export const DEFAULT_MUTATION_LIMITS: MutationLimits = { perMinute: 20, perHour: 200, pausesPerHour: 10 };

function positiveInt(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value || '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function mutationLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): MutationLimits {
    return {
        perMinute: positiveInt(env.SUTRAMX_MAX_WRITES_PER_MINUTE, DEFAULT_MUTATION_LIMITS.perMinute),
        perHour: positiveInt(env.SUTRAMX_MAX_WRITES_PER_HOUR, DEFAULT_MUTATION_LIMITS.perHour),
        pausesPerHour: positiveInt(env.SUTRAMX_MAX_PAUSES_PER_HOUR, DEFAULT_MUTATION_LIMITS.pausesPerHour),
    };
}

export class MutationLimiter {
    private writes: number[] = [];
    private pauses: number[] = [];

    constructor(readonly limits: MutationLimits = DEFAULT_MUTATION_LIMITS, private readonly now: () => number = Date.now) {}

    /** Records one call, or returns why it is refused. */
    take(toolName: string, policy: ToolPolicy): string | null {
        const now = this.now();
        this.writes = this.writes.filter((time) => now - time < 3_600_000);
        this.pauses = this.pauses.filter((time) => now - time < 3_600_000);
        const lastMinute = this.writes.filter((time) => now - time < 60_000).length;
        if (lastMinute >= this.limits.perMinute) return `more than ${this.limits.perMinute} changes in a minute`;
        if (this.writes.length >= this.limits.perHour) return `more than ${this.limits.perHour} changes in an hour`;
        const isPause = toolName === 'sutramx_pause_monitor';
        if (isPause && !policy.allowDestructive && this.pauses.length >= this.limits.pausesPerHour) return `more than ${this.limits.pausesPerHour} monitor pauses in an hour`;
        this.writes.push(now);
        if (isPause) this.pauses.push(now);
        return null;
    }
}

function refused(reason: string): CallToolResult {
    return {
        content: [{ type: 'text', text: `Refused: ${reason} (session limit of this MCP server). Bulk changes need the user: ask them to confirm and make them in the SutramX dashboard, or wait before retrying.` }],
        isError: true,
    };
}

/**
 * Makes server.registerTool skip tools the policy does not allow, and puts
 * every tool that is not read-only behind the session's mutation limiter.
 */
export function applyToolPolicy(server: McpServer, policy: ToolPolicy, limiter: MutationLimiter = new MutationLimiter()): void {
    const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown; }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
        const annotations = (config as { annotations?: Annotations; } | undefined)?.annotations;
        if (!toolAllowed(annotations, policy)) return undefined;
        if (annotations?.readOnlyHint === true) return original(name, config, handler);
        const run = handler as (...args: unknown[]) => Promise<CallToolResult>;
        const limited = async (...args: unknown[]) => {
            const reason = limiter.take(String(name), policy);
            return reason ? refused(reason) : run(...args);
        };
        return original(name, config, limited);
    };
}
