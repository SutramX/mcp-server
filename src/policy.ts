import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/**
 * What the tools of one server instance may do. AI agents can be steered by
 * text they read (prompt injection), so the user, not the agent, decides:
 *
 *  readOnly          only tools annotated readOnlyHint are registered.
 *  allowDestructive  tools annotated destructiveHint (permanent deletes) are
 *                    registered only when this is true. Off by default.
 *
 * stdio: SUTRAMX_READ_ONLY=true / SUTRAMX_ALLOW_DESTRUCTIVE=true.
 * HTTP:  the same env (server-wide), or per request with the headers
 *        X-SutramX-Read-Only: true / X-SutramX-Allow-Destructive: true,
 *        which the user sets in the MCP client config.
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

/** Makes server.registerTool skip tools the policy does not allow. */
export function applyToolPolicy(server: McpServer, policy: ToolPolicy): void {
    const original = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
    (server as unknown as { registerTool: (...args: unknown[]) => unknown; }).registerTool = (name: unknown, config: unknown, handler: unknown) => {
        const annotations = (config as { annotations?: Annotations; } | undefined)?.annotations;
        if (!toolAllowed(annotations, policy)) return undefined;
        return original(name, config, handler);
    };
}
