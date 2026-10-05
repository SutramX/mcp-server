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
| `sutramx_create_monitor` | Create a monitor of any type: `http`, `api`, `ping`, `port`, `udp`, `dns`, `multistep` or `cron` (pass `key` for an idempotent create-or-update) | yes |
| `sutramx_update_monitor` | Change name, URL, interval, config, tags, regions | yes |
| `sutramx_pause_monitor` / `sutramx_resume_monitor` | Stop or restart checks | yes |
| `sutramx_delete_monitor` | Delete a monitor and its history (hidden unless deletes are enabled) | yes, destructive |
| `sutramx_run_check` | Run one real check now | records a check |
| `sutramx_get_check_results` | Check history by region and status, paginated | no |
| `sutramx_list_incidents` / `sutramx_get_incident` | Incidents with confirming regions and acknowledgement | no |
| `sutramx_acknowledge_incident` | Acknowledge (stops escalation) | yes |
| `sutramx_resolve_incident` | Resolve by hand with a note | yes |
| `sutramx_add_incident_note` | Add a timeline note | yes |
| `sutramx_list_status_pages` / `sutramx_get_status_page` | Status pages and the monitors on them | no |
| `sutramx_create_status_page` / `sutramx_update_status_page` | Create a page, or change its `title`, `description`, `slug`, `is_public`, `logo_url`, `accent_color`, `favicon_url`, `hide_powered_by`, `show_response_times` (any other setting is rejected) | yes |
| `sutramx_set_status_page_monitors` | Replace the monitors shown on a page | yes |
| `sutramx_delete_status_page` | Delete a page (hidden unless deletes are enabled) | yes, destructive |
| `sutramx_uptime_report` | Uptime %, incidents, MTTR and health score per monitor over 7/14/30/90 days, plus SLO error budgets and burn rates | no |
| `sutramx_list_maintenance_windows` | Maintenance windows (scope, schedule, recurrence); filter by state | no |
| `sutramx_list_regions` | Probe locations and their codes | no |

Destructive tools are annotated with `destructiveHint`, so clients that support it ask before running them.

### Access modes

Agents can be steered by text they read (prompt injection), so the user, not the agent, chooses which tools the server offers. Tools that are not allowed are not registered at all: the agent never sees them.

| Mode | stdio (env) | HTTP (env for the whole server, or a header per client) | Tools offered |
|---|---|---|---|
| read-only | `SUTRAMX_READ_ONLY=true` | `X-SutramX-Read-Only: true` | only the "no" rows above |
| default | (neither set) | (neither set) | everything except the two delete tools |
| deletes enabled | `SUTRAMX_ALLOW_DESTRUCTIVE=true` | `X-SutramX-Allow-Destructive: true` | everything |

- Both settings are off by default, so `sutramx_delete_monitor` and `sutramx_delete_status_page` are hidden unless deletes are enabled. `true`, `1`, `yes` and `on` (any case) turn a setting on; anything else leaves it off.
- Read-only wins: with read-only on, the delete tools stay hidden even when deletes are enabled.
- HTTP mode: a header can only add to the server's environment, not take away from it. `SUTRAMX_READ_ONLY=true` on the server makes every request read-only whatever the headers say, and `SUTRAMX_ALLOW_DESTRUCTIVE=true` on the server enables deletes for every request that is not read-only. Without them, each client chooses with its own headers.
- Use read-only mode for assistants that only need to look (triage, reporting), ideally together with a Read-only API key (below).

## 1. Create an API key

In SutramX, open **Settings → API keys → Create API key**. Keys start with `sk_` and are shown once.

**Recommended for agents: a Read-only key.** It can call every "no" tool above, and the SutramX API itself refuses every change it attempts (`403 READ_ONLY_ACCESS`), so a leaked key or a prompt-injected agent cannot create, pause, acknowledge, resolve or delete anything. This holds even if the server's own read-only mode is off; combine both (`SUTRAMX_READ_ONLY=true` hides the write tools from the agent as well). Use a Standard key only for an agent that really needs to change things; it is enough for every tool above.

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

### Hosted server with OAuth (Claude.ai and other remote clients)

The hosted server at `https://api.sutramx.com/mcp` also accepts OAuth 2.1, so clients that cannot store an API key (for example a Claude.ai custom connector) only need the URL. On the first request without credentials the server answers `401` with `WWW-Authenticate: Bearer resource_metadata="https://api.sutramx.com/.well-known/oauth-protected-resource/mcp"`; the client registers itself (dynamic client registration), sends you to SutramX to approve, and gets an access token (PKCE S256, resource indicator `https://api.sutramx.com/mcp`).

On the consent page you pick the workspace and the permissions: `monitors:read`, `incidents:read`, `status_pages:read` (on by default) and `monitors:write`, `incidents:write`, `status_pages:write` (off unless you tick them; workspace viewers can only grant read). A token without a write scope gets only the read tools. Delete tools stay off unless the client sends `X-SutramX-Allow-Destructive: true`. OAuth tokens can never manage API keys, team members, billing, SSO or account settings. Access tokens last one hour and are refreshed automatically; revoke an app any time in SutramX → Settings → Authorized apps.

Self-hosting the HTTP server with OAuth: set `MCP_RESOURCE_URL` to the public URL of your `/mcp` endpoint and `MCP_AUTHORIZATION_SERVER` to your SutramX API, and serve `/.well-known/oauth-protected-resource*` from this server.

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `SUTRAMX_API_KEY` | (required for stdio) | Workspace API key |
| `SUTRAMX_API_URL` | `https://api.sutramx.com` | API base URL (self-hosted or staging) |
| `TRANSPORT` | `stdio` | `http` is the same as `--http` |
| `HOST` / `PORT` | `127.0.0.1` / `3333` | HTTP listener |
| `MCP_ALLOWED_HOSTS` | (none) | Allowed `Host` headers when not on loopback |
| `SUTRAMX_READ_ONLY` | `false` | Register only read tools |
| `SUTRAMX_ALLOW_DESTRUCTIVE` | `false` | Register the delete tools |
| `MCP_RESOURCE_URL` | `<SUTRAMX_API_URL>/mcp` | HTTP + OAuth: canonical URL of this `/mcp` endpoint (token audience) |
| `MCP_AUTHORIZATION_SERVER` | `SUTRAMX_API_URL` | HTTP + OAuth: issuer named in the protected-resource metadata |
| `OAUTH_RESOURCE_PROXY_SECRET` | (none) | HTTP + OAuth: sent to the API with OAuth tokens when the API requires it |
| `MCP_ALLOWED_ORIGINS` | (none) | Extra browser origins allowed to call `/mcp` (comma-separated, e.g. `https://app.example.com`); requests without `Origin` are always allowed |

## Notes

- Plan limits apply exactly as in the dashboard. When a tool returns `ENTITLEMENT_LIMIT_REACHED` or `FEATURE_NOT_AVAILABLE`, the plan does not allow it.
- Billing, team members and API keys cannot be managed with an API key, and so not with this server. Per-monitor alert recipients (`config.notification_emails`) can only be set with an API key that has Automation access; other keys get a clear error.
- Maintenance windows can be listed but not created, changed or deleted: they silence alerting, so the API makes them owner-only and refuses every API key (`403 WORKSPACE_OWNER_REQUIRED`). SLO targets are set in the dashboard; `sutramx_uptime_report` reads them.
- With a read-only key, `sutramx_whoami` reports `read_only: true`, and any write tool returns `READ_ONLY_ACCESS` with a hint telling the agent not to retry.
- `config` on `sutramx_update_monitor` replaces the whole object. Agents are told to read the monitor first and send the merged config.

## Security

- `SUTRAMX_API_URL` must be `https://` (plain `http://` only for loopback); the server refuses to start otherwise, warns when `NODE_TLS_REJECT_UNAUTHORIZED=0`, and never follows redirects with a key.
- Credentials stored in monitor config (headers such as `Authorization`/`Cookie`, keys named like `*token*`, `*secret*`, `*password*`, `*api_key*`, and passwords in URLs) are returned as `[REDACTED]`. Sending `[REDACTED]` back in `sutramx_update_monitor` keeps the stored value; it cannot stand for a value that is not stored.
- Text that comes from monitored sites or other people (check errors, names, notes) is shown single-line inside `«»`, without control characters, and the server instructions tell the agent to treat it as data.
- Ids are UUIDs, keys and slugs match strict patterns, times must be ISO-8601, so tool arguments cannot change the API path or add query parameters.
- HTTP mode: every request needs its own `Authorization: Bearer sk_...`; the env key is only a fallback on loopback. Put a rate limiter in front of a public deployment (the API itself rate-limits per key).

## Development

```bash
npm run dev          # stdio, from source
npm test             # tool tests against a fake API
npx @modelcontextprotocol/inspector node dist/index.js   # interactive inspector
```

## License

MIT, see [LICENSE](LICENSE).
