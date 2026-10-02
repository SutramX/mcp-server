# SutramX MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets AI agents and assistants (Claude Code, Claude Desktop and other MCP clients) work with your SutramX workspace: list and change monitors, read check results, handle incidents and manage status pages.

It talks to the public SutramX API with a workspace API key, so it can do exactly what that key can do and nothing more.

## Tools

| Tool | What it does | Changes data? |
|---|---|---|
| `sutramx_whoami` | Workspace, plan and limits for the key | no |
| `sutramx_monitor_summary` | Counts by status, open incidents, 24h uptime | no |
| `sutramx_list_monitors` | Monitors with live status and uptime; filter by status, tag, text | no |
| `sutramx_get_monitor` | One monitor by id or monitoring-as-code key | no |
| `sutramx_create_monitor` | Create a monitor (pass `key` for an idempotent create-or-update) | yes |
| `sutramx_update_monitor` | Change name, URL, interval, config, tags, regions | yes |
| `sutramx_pause_monitor` / `sutramx_resume_monitor` | Stop or restart checks | yes |
| `sutramx_delete_monitor` | Delete a monitor and its history | yes, destructive |
| `sutramx_run_check` | Run one real check now | records a check |
| `sutramx_get_check_results` | Check history by region and status, paginated | no |
| `sutramx_list_incidents` / `sutramx_get_incident` | Incidents with confirming regions and acknowledgement | no |
| `sutramx_acknowledge_incident` | Acknowledge (stops escalation) | yes |
| `sutramx_resolve_incident` | Resolve by hand with a note | yes |
| `sutramx_add_incident_note` | Add a timeline note | yes |
| `sutramx_list_status_pages` / `sutramx_get_status_page` | Status pages and the monitors on them | no |
| `sutramx_create_status_page` / `sutramx_update_status_page` | Create or edit a page | yes |
| `sutramx_set_status_page_monitors` | Replace the monitors shown on a page | yes |
| `sutramx_delete_status_page` | Delete a page | yes, destructive |
| `sutramx_list_regions` | Probe locations and their codes | no |

Destructive tools are annotated with `destructiveHint`, so clients that support it ask before running them.

## 1. Create an API key

In SutramX, open **Settings → API keys → Create API key**. Keys start with `sk_` and are shown once. A standard key is enough for every tool above.

## 2. Build

```bash
cd mcp-server
npm install
npm run build
```

Node.js 20 or newer is required.

## 3. Connect a client

### Claude Code

```bash
claude mcp add sutramx \
  --env SUTRAMX_API_KEY=sk_your_key \
  -- node /absolute/path/to/mcp-server/dist/index.js
```

Or add it to `.mcp.json` in a project:

```json
{
  "mcpServers": {
    "sutramx": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": { "SUTRAMX_API_KEY": "sk_your_key" }
    }
  }
}
```

### Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`, Windows: `%APPDATA%\Claude\claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "sutramx": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/dist/index.js"],
      "env": { "SUTRAMX_API_KEY": "sk_your_key" }
    }
  }
}
```

Restart Claude Desktop. Try: "Which SutramX monitors are down right now, and since when?"

### Streamable HTTP (remote or shared)

```bash
PORT=3333 node dist/index.js --http
```

The endpoint is `POST http://127.0.0.1:3333/mcp` (stateless, JSON responses). Every request must send its own SutramX key:

```
Authorization: Bearer sk_your_key
```

so one server can serve several users and workspaces. Connect Claude Code to it with:

```bash
claude mcp add --transport http sutramx http://127.0.0.1:3333/mcp \
  --header "Authorization: Bearer sk_your_key"
```

When the server listens on loopback (the default, `HOST=127.0.0.1`), `SUTRAMX_API_KEY` is used for requests that send no `Authorization` header (a header that is not a SutramX key is rejected with 401). Browser requests are only accepted from a loopback `Origin` or one listed in `MCP_ALLOWED_ORIGINS`. With any other `HOST` the environment key is ignored, and you should put the server behind HTTPS. Set `MCP_ALLOWED_HOSTS` (comma-separated host names) to keep DNS-rebinding protection when binding to `0.0.0.0`. `GET /health` returns the server version.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SUTRAMX_API_KEY` | (required for stdio) | Workspace API key |
| `SUTRAMX_API_URL` | `https://api.sutramx.com` | API base URL (self-hosted or staging) |
| `TRANSPORT` | `stdio` | `http` is the same as `--http` |
| `HOST` / `PORT` | `127.0.0.1` / `3333` | HTTP listener |
| `MCP_ALLOWED_HOSTS` | (none) | Allowed `Host` headers when not on loopback |
| `MCP_ALLOWED_ORIGINS` | (none) | Extra browser origins allowed to call `/mcp` (comma-separated, e.g. `https://app.example.com`); requests without `Origin` are always allowed |

## Notes

- Plan limits apply exactly as in the dashboard. When a tool returns `ENTITLEMENT_LIMIT_REACHED` or `FEATURE_NOT_AVAILABLE`, the plan does not allow it.
- Alert routing (per-monitor email recipients), billing, team and API keys are not available to API keys and so not to this server.
- `config` on `sutramx_update_monitor` replaces the whole object. Agents are told to read the monitor first and send the merged config.

## Development

```bash
npm run dev          # stdio, from source
npm test             # tool tests against a fake API
npx @modelcontextprotocol/inspector node dist/index.js   # interactive inspector
```
