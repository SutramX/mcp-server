import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from './constants.js';
import type { SutramXClient } from './client.js';
import { registerAccountTools } from './tools/account.js';
import { registerMonitorTools } from './tools/monitors.js';
import { registerIncidentTools } from './tools/incidents.js';
import { registerStatusPageTools } from './tools/statusPages.js';

/** One MCP server bound to one SutramX API key (one workspace). */
export function createSutramXServer(client: SutramXClient): McpServer {
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        {
            instructions: [
                'SutramX is an uptime monitoring service. These tools act on one workspace (the one the API key belongs to).',
                'Start with sutramx_monitor_summary or sutramx_list_monitors; ids come from list tools.',
                'A monitor is "down" only when an incident is open (confirmed from several regions); "degraded" means a slow or unconfirmed failing check.',
                'Ask the user before deleting monitors or status pages or resolving incidents.',
            ].join(' '),
        }
    );
    registerAccountTools(server, client);
    registerMonitorTools(server, client);
    registerIncidentTools(server, client);
    registerStatusPageTools(server, client);
    return server;
}
