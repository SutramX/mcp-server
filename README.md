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
| `sutramx_delete_monitor` | Delete a monitor and its history (only with `SUTRAMX_ALLOW_DESTRUCTIVE`) | yes, destructive |
| `sutramx_run_check` | Run one real check now | records a check |
| `sutramx_get_check_results` | Check history by region and status, paginated | no |
| `sutramx_list_incidents` / `sutramx_get_incident` | Incidents with confirming regions and acknowledgement | no |
| `sutramx_acknowledge_incident` | Acknowledge (stops escalation) | yes |
| `sutramx_resolve_incident` | Resolve by hand with a note | yes |
| `sutramx_add_incident_note` | Add a timeline note | yes |
| `sutramx_list_status_pages` / `sutramx_get_status_page` | Status pages and the monitors on them | no |
| `sutramx_create_status_page` / `sutramx_update_status_page` | Create or edit a page | yes |
| `sutramx_set_status_page_monitors` | Replace the monitors shown on a page | yes |
| `sutramx_delete_status_page` | Delete a page (only with `SUTRAMX_ALLOW_DESTRUCTIVE`) | yes, destructive |
| `sutramx_uptime_report` | Uptime %, incidents, MTTR and health score per monitor over 7/14/30/90 days, plus SLO error budgets and burn rates | no |
| `sutramx_list_maintenance_windows` | Maintenance windows (scope, schedule, recurrence); filter by state | no |
| `sutramx_list_regions` | Probe locations and their codes | no |

Destructive tools are annotated with `destructiveHint`, so clients that support it ask before running them.

### Access modes

Agents can be steered by text they read (prompt injection), so the user, not the agent, chooses what the server may do:

| Mode | stdio (env) | HTTP (env for the whole server, or a header per client) | Tools |
|---|---|---|---|
| read-only | `SUTRAMX_READ_ONLY=true` | `X-SutramX-Read-Only: true` | only the "no" rows above |
| default | | | everything except permanent deletes |
| deletes enabled | `SUTRAMX_ALLOW_DESTRUCTIVE=true` | `X-SutramX-Allow-Destructive: true` | everything |

**Breaking change:** `sutramx_delete_monitor` and `sutramx_delete_status_page` are no longer offered unless deletes are enabled. Use read-only mode for assistants that only need to look (triage, reporting). Server-wide `SUTRAMX_READ_ONLY` cannot be overridden by a header.

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
| `MCP_ALLOWED_ORIGINS` | (none) | Extra browser origins allowed to call `/mcp` (comma-separated, e.g. `https://app.example.com`); requests without `Origin` are always allowed |

## Notes

- Plan limits apply exactly as in the dashboard. When a tool returns `ENTITLEMENT_LIMIT_REACHED` or `FEATURE_NOT_AVAILABLE`, the plan does not allow it.
- Alert routing (per-monitor email recipients), billing, team and API keys are not available to API keys and so not to this server.
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

## Releasing

1. Bump the version in `package.json`, `src/constants.ts` (`SERVER_VERSION`) and `server.json` (`version` and `packages[0].version`); `npm run check-version` verifies they agree.
2. Commit and push a tag `v<version>`. `.github/workflows/release.yml` checks the tag against those files, runs typecheck, tests and build, and publishes to npm with provenance (needs the `NPM_TOKEN` repository secret). `npm pack --dry-run` shows exactly what will be published.
3. After the npm release, publish `server.json` to the [MCP Registry](https://registry.modelcontextprotocol.io) with `mcp-publisher login github` (as a member of the `sutramx` GitHub organization, which owns the `io.github.sutramx/*` namespace) and `mcp-publisher publish`. The registry checks that the npm package's `mcpName` equals the `name` in `server.json`.

## License

MIT, see [LICENSE](LICENSE).
