# Changelog

All notable changes to `@sutramx/mcp-server` are listed here. Releases are the `vX.Y.Z` git tags and the versions on npm and the MCP Registry.

## Unreleased

### Fixed

- **Retries never run an action twice.** Every `POST` carries an `Idempotency-Key` that its retry reuses. Reads (the read-only monitor `plan` included), `PUT`, `DELETE` and the creates the API runs once per key (monitors, status pages, incident notes ...) are retried once after a network error, a timeout (30 seconds) or HTTP 502/503/504. A `409 IDEMPOTENCY_REQUEST_IN_PROGRESS` answer (the first try is still running) waits and asks again with the same key. Other `POST`s (acknowledge, resolve, pause, resume, run-check) are sent once after a network error, a timeout or a 5xx, and the error goes back to the agent, since a retry could run them twice.
- HTTP 429 is retried once for every call, actions included (the API refuses it before running it). `Retry-After` is read as seconds or as an HTTP date; a wait longer than 5 seconds is returned to the agent instead.
- Plan limits (`category: PLAN_LIMIT` and every limit code, also when sent as 429) tell the agent that a higher plan is needed and not to retry.
- A network failure names its cause and the host (`ECONNREFUSED`, `ENOTFOUND`, `ETIMEDOUT`, certificate errors) instead of `HTTP 0`. A response that is not JSON is an error, and a plain-text 429 body is shown as the message.
- Tool descriptions say "monitoring locations".
- The Arizona, USA monitoring location code is now `usa-az` (`sutramx_list_regions` lists it) and tool descriptions use it. The earlier code is still accepted in `regions`; the API saves and returns it as `usa-az`.

### Added

- Proxy support: `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` (or lower case). Behind a TLS-inspecting proxy, point `NODE_EXTRA_CA_CERTS` at its CA certificate.
- API calls send `X-SutramX-Client: sutramx-mcp-server/<version>` next to the `User-Agent`.

## 0.1.5 (October 10, 2026)

- `sutramx_explain_incident`: read-only "why is it down?" tool, by incident id, monitor id or monitor name or key.

## 0.1.4 (October 10, 2026)

- HTTP server: failed credentials are limited per client address; it refuses to start in production without the OAuth resource proof secret; browser origins must be listed in `MCP_ALLOWED_ORIGINS`.

## 0.1.3 (October 6, 2026)

- Published from GitHub Actions with npm Trusted Publishing; company contact in the package metadata.

## 0.1.2 (October 6, 2026)

- `mcp` monitor type in `sutramx_create_monitor` and `sutramx_update_monitor`; `sutramx_run_check` shows the MCP server, protocol, tools and drift.
- Hosted server with OAuth (for connectors such as Claude.ai), safe-by-default tools, per-session write limits, untrusted text fenced.

## 0.1.1 (October 4, 2026)

- MCP Registry name `io.github.SutramX/mcp-server`.

## 0.1.0 (October 3, 2026)

First public release: stdio and hosted HTTP server, monitor, incident, status page, uptime report and maintenance window tools, read-only mode and destructive tools off by default.

Earlier detail: see the git history.
