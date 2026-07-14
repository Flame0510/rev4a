# Olympus API Reference

> **Last updated:** 2026-07-03

All routes are under `/api/`. Authentication is required on every endpoint
unless otherwise noted.

---

## Authentication

### Bearer token (programmatic)
```
Authorization: Bearer <OLYMPUS_TOKEN>
```
Set `OLYMPUS_TOKEN` env var. No default — auth is disabled when unset.

### Browser cookie (UI)
After a successful `POST /api/auth/login`, the server sets an `olympus_token`
cookie (signed JWT, 7-day expiry). All subsequent UI requests use this cookie
automatically.

### API-only fallbacks (in order of precedence)
1. `Authorization: Bearer <token>`
2. `?token=<token>` query param
3. `x-agent-token` header

For Control UI deep links, prefer `#token=<token>` instead of `?token=<token>`. The hash fragment is consumed by the browser client before the WebSocket connects.

---

## Auth

### `POST /api/auth/login`
Login — exchange the static password for a signed JWT cookie.

**Body:** `{ "password": "***" }`

**Response:**
```json
{ "ok": true }
```
Sets `Set-Cookie: olympus_token=<jwt>; HttpOnly; SameSite=Lax`.

**Error:** `401` if password is wrong.

### `GET /api/auth/check`
Validate the current browser cookie and report whether the user is authenticated.

**Auth:** browser cookie

**Response:**
```json
{ "authenticated": true }
```

**Error:** `401` with `{ "authenticated": false }` if the cookie is missing or invalid.

### `POST /api/auth/logout`
Delete the `olympus_token` cookie.

**Auth:** browser cookie

**Response:**
```json
{ "ok": true }
```

---

## Gateway

The Gateway API reads the model catalogue from [`models.config.json`](../models.config.json)
(tracked in the repository). Full documentation at [GATEWAY.md](GATEWAY.md) and
[PROVIDERS.md](PROVIDERS.md).

### `GET /api/gateway`
Returns live gateway status from all agent containers.

**Auth:** any auth method

**Response:**
```json
{
  "agents": {
    "total": 1,
    "list": [
      {
        "containerName": "openclaw-atlas",
        "agentId": "atlas",
        "agentName": "Atlas",
        "defaultModel": "olympus/deepseek/deepseek-v4-flash",
        "configured": true
      }
    ]
  }
}
```

### `PUT /api/gateway/provider`
Trigger a full provider model sync to all agent containers.

**Auth:** any auth method

**Body:** none (reads current provider state from `models.config.json` and `data/provider-keys.json`)

**Response:**
```json
{
  "status": "ok",
  "activeModels": 2,
  "results": ["Active models: 2 across 1 agent(s)"]
}
```

**Side effects:**
- Writes `models.providers.olympus` to each agent container's `openclaw.json`
- Cleans up stale `models.json` and `auth-profiles.json` inside containers
- **Does NOT touch `agents.defaults.model` or `agents.list[].model`** — model references are managed per-container via the Agents Tab (`PUT /api/gateway/agent`)
- Does NOT restart the gateway (config is written live to the file)

### `PUT /api/gateway/agent`
Update model config for a single agent container.

**Auth:** any auth method

**Body:**
```json
{
  "containerName": "openclaw-atlas",
  "model": "deepseek/deepseek-v4-flash",
  "fallbacks": []
}
```
If `fallbacks` is omitted or empty, no fallback models are set.

**Response:**
```json
{
  "status": "ok",
  "agent": "openclaw-atlas",
  "model": {
    "primary": "olympus/deepseek/deepseek-v4-flash"
  },
  "verify": { "ok": true, "bytes": 2058 }
}
```

**Behaviour:**
- Writes `agents.defaults.model.primary` and `agents.list[0].model.primary` with format `olympus/<provider>/<model>`
- No restart — writes are live via `docker exec node -e`
- Does NOT set fallbacks unless explicitly provided

### `GET /api/gateway/provider`
Returns current provider configuration state.

**Auth:** any auth method

**Response:**
```json
{
  "providers": [
    {
      "provider": "deepseek",
      "label": "DeepSeek",
      "configured": true,
      "baseUrl": "https://api.deepseek.com",
      "docsUrl": "https://platform.deepseek.com/api_keys",
      "models": [
        { "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash", "enabled": true },
        { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "enabled": true }
      ]
    }
  ]
}
```

### `GET /api/provider/v1/models`

Olympus Provider Gateway — returns available models filtered by auth token.

**Auth:** Bearer token (must match `olympus` key in `data/provider-keys.json`)

**Response (authenticated):**
```json
{
  "object": "list",
  "total": 9,
  "data": [
    { "id": "deepseek/deepseek-v4-flash", "object": "model", "created": 1700000000, "owned_by": "deepseek", "permission": [], "root": "deepseek/deepseek-v4-flash" }
  ]
}
```

**Response (unauthenticated):**
```json
{ "object": "list", "total": 0, "data": [] }
```

### `POST /api/provider/v1/chat/completions`

Olympus Provider Gateway — proxy chat completions to the correct upstream.

**Auth:** Bearer token (must match `olympus` key in `data/provider-keys.json`)

**Body:**
```json
{
  "model": "olympus/deepseek-v4-flash",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**Error (401):**
```json
{ "error": { "message": "Invalid API key...", "type": "authentication_error" } }
```

---

## Config

### `PUT /api/config/env`
Update environment variables on the VPS host.

**Auth:** browser cookie

**Body:** `{ "OLYMPUS_PASSWORD": "newpass", ... }`

**Side effects:**
- Writes to `.env` in the project root
- Automatically syncs to `/etc/systemd/system/olympus.service` (removes all `Environment=OLYMPUS_*` and `Environment=PROVIDER_*` lines, appends current vars)
- Runs `systemctl daemon-reload` so the next restart picks up the new environment
- Only keys prefixed with `OLYMPUS_` or `PROVIDER_` are accepted

**Response:** `{ "status": "ok", "updated": ["OLYMPUS_PASSWORD", ...] }`

**Error (400):** `{ "error": "Keys not allowed: ..." }`

### `POST /api/config/restart`
Restart the Olympus server (via systemd).

**Auth:** browser cookie

**Response:** `{ "status": "ok", "message": "Service restarted" }`

---

## Sessions

### `GET /api/sessions`
Returns all sessions (up to 2000), newest first, joined with lineage labels.

**Auth:** browser cookie

**Response:**
```json
[
  {
    "session_id": "agent:ops:main",
    "parent_id": null,
    "label": "Argus",
    "model": "openai-codex/gpt-5.4",
    "tokens_in": 12500,
    "tokens_out": 3200,
    "cost_usd": 0.085,
    "status": "idle",
    "task_preview": "Run hygiene audit...",
    "started_at": 1749200000,
    "ended_at": null,
    "updated_at": 1749201000,
    "trello_card_url": null,
    "lineage_label": null,
    "lineage_agent_name": null
  }
]
```

---

### `GET /api/session?id=<session_id>`
Returns a single session with its events and child sessions.

**Auth:** browser cookie

**Query params:** `id` (required)

**Response:**
```json
{
  "session": { ...session row... },
  "events": [ ...event rows... ],
  "children": [ ...session rows... ]
}
```

**Error:** `400` if `id` missing; `404` if not found.

---

## Stats & Costs

### `GET /api/stats`
Current-month aggregate stats (tokens + cost) grouped by model.

**Auth:** Bearer or browser cookie

**Response:**
```json
{
  "total": {
    "total": 1.24,
    "total_in": 850000,
    "total_out": 210000,
    "sessions": 47
  },
  "byModel": [
    { "model": "openai-codex/gpt-5.4", "cost": 0.95, "tokens_in": 600000, "tokens_out": 150000, "sessions": 30 }
  ]
}
```

---

### `GET /api/stats-since?ts=<unix_ms>`
Total cost (USD) since a given timestamp.

**Auth:** Bearer or browser cookie

**Query params:** `ts` — Unix timestamp in milliseconds

**Response:**
```json
{ "total": 0.42 }
```

---

### `GET /api/costs`
Full cost breakdown: today, 7d, 30d, all-time, per-model, plus cost-override for the current month.

**Auth:** browser cookie

**Response:**
```json
{
  "today": 0.12,
  "week": 1.85,
  "month": 6.40,
  "allTime": 42.10,
  "override": null,
  "byModel": [ ... ]
}
```

---

### `GET /api/cost-override?month=YYYY-MM`
Read manual cost override for a month.

**Auth:** Bearer or browser cookie

**Response:** `{ "month": "2026-06", "amount": 124.10, "note": "GitHub billing" }` or `{ "month": "2026-06", "amount": null, "note": null }` if not set.

---

### `POST /api/cost-override`
Set or update a manual cost override.

**Auth:** Bearer or browser cookie

**Body:** `{ "month": "2026-06", "amount": 124.10, "note": "GitHub billing" }`

**Response:** `{ "ok": true }`

**Error:** `400` if `amount` missing.

---

## Events

### `GET /api/events?limit=50&offset=0`
Paginated event log.

**Auth:** browser cookie

**Query params:** `limit` (default 50), `offset` (default 0)

**Response:**
```json
[
  {
    "id": 1042,
    "ts": 1749201500000,
    "session_id": "agent:ops:subagent:uuid",
    "type": "spawn",
    "data": "{\"task\":\"run hygiene...\"}"
  }
]
```

---

### `GET /api/stream`
Server-Sent Events stream. Pushes a combined payload every ~3 s.

**Auth:** browser cookie

**Event format:**
```
data: {"events":[...],"sessions":[...],"costs":{"today":0.12},"lineage":[...]}
```

Use `EventSource` in the browser or `curl -N` for testing.

### `GET /api/workspace/stream`
Workspace filesystem change stream for the editor.

**Auth:** browser cookie

**Response:** `text/event-stream`

**Event types:**
- `workspace_ready` — initial snapshot metadata
- `workspace_changed` — added, modified, or removed files/directories
- `heartbeat` — emitted when no changes are detected
- `workspace_error` — emitted if a scan cycle fails

**Initial payload example:**
```json
{
  "type": "workspace_ready",
  "ts": 1751270000000,
  "root": "/path/to/workspace",
  "count": 42
}
```

**Change payload example:**
```json
{
  "type": "workspace_changed",
  "ts": 1751270003000,
  "changed": [
    {
      "path": "/path/to/workspace/olympus/README.md",
      "rel_path": "olympus/README.md",
      "type": "file",
      "size": 2048,
      "mtimeMs": 1751270002999,
      "change": "modified"
    }
  ],
  "truncated": false
}
```

**Notes:**
- The stream polls every 3 seconds.
- Hidden paths and directories such as `.trash` and `node_modules` are ignored.
- Only a fixed allowlist of file extensions is included.

---

## Tool Calls

### `GET /api/tool-calls?session_id=<id>`
Tool call events for a session.

**Auth:** Bearer or browser cookie

**Query params:** `session_id` (required)

**Response:**
```json
[
  { "id": 12, "ts": 1749200100000, "session_id": "...", "type": "tool_call", "data": "{...}" }
]
```

---

## Agents

### `GET /api/agents`
List running agent containers (Docker containers with `AGENT_ID` label) with full metadata.

**Auth:** browser cookie

**Response:**
```json
[
  {
    "id": "abc123def456",
    "agentId": "prometheus",
    "name": "prometheus",
    "image": "openclaw-agent-base:latest",
    "imageTag": "latest",
    "template": "prometheus",
    "status": "running",
    "state": "running",
    "ports": "",
    "ip": "172.19.0.5",
    "created": "2026-07-01T16:58:42.876829416Z",
    "env": ["AGENT_ID=prometheus", "AGENT_HOSTNAME=<agent-name>.<your-domain>.com"],
    "authToken": "***",
    "traefikUrl": "https://prometheus.mydomain.com#token=asdfghjkl"
  },
  {
    "id": "fedcba098765",
    "agentId": "my-agent",
    "name": "my-agent",
    "image": "openclaw-agent-base:latest",
    "imageTag": "latest",
    "template": "prometheus",
    "status": "running",
    "state": "running",
    "ports": "0.0.0.0:3033->3000/tcp",
    "ip": "172.19.0.5",
    "created": "2026-07-01T16:58:42.876829416Z",
    "env": ["AGENT_ID=my-agent", "AGENT_HOSTNAME=203.0.113.10:3033"],
    "authToken": "***",
    "traefikUrl": "http://203.0.113.10:3033#token=asdfghjkl"
  }
]

**Notes:**
- The URL (`traefikUrl`) reflects the creation mode:
  - With `OLYMPUS_DOMAIN` set + Traefik running → HTTPS subdomain URL (`https://<name>.<domain>#...`)
  - Otherwise → HTTP IP+port URL (`http://<host-ip>:<port>#...`)
- The `authToken` uses the shared gateway token from `data/agents-token.json`
- Containers are discovered via Docker API with label filter `AGENT_ID`
- Template is inferred from the container image name + agent ID directory match in `agent-templates/`
- Existing containers (created before domain update) will still show the old URL pattern

---

### `POST /api/agents/create`
Create a new agent container from a template.

**Auth:** browser cookie

**Body:**
```json
{
  "name": "my-agent",
  "template": "prometheus",
  "port": 3033,
  "model": "deepseek/deepseek-v4-flash"
},
  "template": "prometheus",
  "port": 3033,
  "model": "deepseek/deepseek-v4-flash"
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Container name, also becomes `AGENT_ID` and subdomain |
| `template` | yes | Template name (directory in `agent-templates/`) |
| `port` | no | Optional host port (auto-assigned if empty and no Traefik) |
| `model` | no | Primary model ID from `models.config.json` |

**Creation mode is determined automatically:**
- **Traefik mode** — if a running Traefik container is detected **and** `OLYMPUS_DOMAIN` is set. Agents get Traefik labels for HTTPS subdomain routing without host port exposure.
- **Direct mode** — otherwise. Agents expose a host port (`-p <port>:3000`) and are reachable via `http://<host-ip>:<port>`. Port is auto-assigned from 3000+.

**Response (Traefik mode):**
```json
{
  "success": true,
  "containerId": "00f5de1eb08d...",
  "name": "my-agent",
  "image": "openclaw-agent-base:latest",
  "network": "openclaw-core_default",
  "traefikUrl": "https://my-agent.mydomain.com#token=asdfghjkl"
}
```
No host port exposed — Traefik routes HTTPS via the subdomain.

**Response (Direct mode — no Traefik):**
```json
{
  "success": true,
  "containerId": "00f5de1eb08d...",
  "name": "my-agent",
  "image": "openclaw-agent-base:latest",
  "network": "openclaw-core_default",
  "traefikUrl": "http://203.0.113.10:3033#token=asdfghjkl"
}
```
The container's port 3000 is mapped to the auto-assigned (or user-specified) host port.
The URL uses the host's public IP address since no domain is configured.

**Post-creation pipeline:**
1. OpenClaw gateway starts with `--allow-unconfigured`, generating its own default config
2. The route waits for the gateway to be fully up (health check poll, up to 20 s)
3. Once ready, writes `gateway.controlUi.allowedOrigins` + `agents.defaults.model.primary` + fallbacks
4. Calls `syncAgent(name)` to write `models.providers.olympus` into the container
5. In Traefik mode: Traefik labels are set for HTTPS via Let's Encrypt

> **Note:** The entrypoint no longer generates `openclaw.json`. All post-creation config is written by the create route after gateway readiness, eliminating the race condition where the entrypoint would overwrite synced provider config.

**Side effects:**
- Template files (`AGENTS.md`, `SOUL.md`, etc.) are volume-mounted from the template directory
- The agent URL is included in the response (subdomain or IP+port)
- An event is logged to `data/events.db` if available

**Error:** `400` for validation errors, `409` if name/port already in use

---

### `DELETE /api/agents/[id]`
**Destructive.** Permanently deletes the agent: the container, its persistent
volume (`agent-<id>-data`), and **all** its backups (`agent-<id>-*.tar.gz` in the
`olympus-backups` volume). This cannot be undone. Volume and backup removal are
best-effort — a missing volume or absent backups do not fail the delete.

The `id` is validated (`isValidAgentId`) before being interpolated into any
docker command.

**Auth:** browser cookie

**Response:**
```json
{ "success": true }
```

**Error (400):** `{ "success": false, "error": "Invalid agent id" }`
**Error (404):** `{ "error": "No container found with AGENT_ID '...'" }`

---

### `POST /api/agents/[id]/restart`
Restart an agent container (shorter than recreate — keeps everything intact).

**Auth:** browser cookie

**Response:**
```json
{ "success": true }
```

**Error (404):** `{ "error": "No container found with AGENT_ID '...'" }`

---

### `POST /api/agents/[id]/backup`
Create a backup of the agent's persistent volume.

**Auth:** browser cookie

**Response:**
```json
{ "success": true, "file": "agent-prometheus-2026-07-12_043512345.tar.gz" }
```

The backup file lives in Docker volume `olympus-backups`. Backups exclude the npm
package cache (`~/.npm/_cacache/`) to keep them small (~1.5 MB instead of 227 MB).

**Error (404):** `{ "error": "No persistent volume found for agent '...'" }`

---

### `GET /api/agents/[id]/backup`
List available backups for a specific agent.

**Auth:** browser cookie

**Response:**
```json
{
  "backups": [
    { "name": "agent-prometheus-2026-07-12_043512345.tar.gz", "size": "1.6 MB", "date": "12/07/2026 04:35" }
  ]
}
```

Backups are sorted most-recent-first.

---

### `DELETE /api/agents/[id]/backup?file=agent-prometheus-2026-07-12_043512345.tar.gz`
Remove a specific backup file.

**Auth:** browser cookie

**Response:**
```json
{ "success": true }
```

**Error (400):** if filename is invalid or contains path traversal

---

### `POST /api/agents/[id]/restore?file=agent-prometheus-2026-07-12_043512345.tar.gz`
Restore an agent's persistent volume from a backup.

The container is stopped, the volume content is replaced with the backup, then
the container is restarted. If no container exists with the given `AGENT_ID`,
the volume is restored anyway (useful for volume-only agents).

**Auth:** browser cookie

**Response:**
```json
{ "success": true, "container": "prometheus" }
```

**Error (404):** if the backup file is not found

---

### `POST /api/agents/[id]/recreate`
Rebuild the agent container from the **latest** `openclaw-agent-base:latest` image
while preserving the persistent volume (workspace files, credentials, state DB,
config). This is how an existing agent picks up image/OpenClaw/CLI updates: the
software lives in the image, the data in the volume.

Flow:
1. **Auto-backup first.** The volume is backed up to `agent-<id>-prerecreate-<ts>.tar.gz`
   in `olympus-backups`. **If the backup fails, the recreate is aborted** and the
   running container is left untouched.
2. The old container is removed (`docker rm -f`) and a new one is created with the
   same image tag, environment variables (`AGENT_*`, `MODEL_*`, `OPENCLAW_*`),
   labels, port mappings, and network — reattaching the same volume.

On the next boot, the image entrypoint runs `openclaw doctor --non-interactive`
**only if the OpenClaw version changed** (safe migrations, no service restart),
aligning the volume's state/config to the new binary.

**Auth:** browser cookie

**Response:**
```json
{ "success": true, "name": "prometheus", "image": "openclaw-agent-base:latest", "network": "openclaw-core_default", "backup": "agent-prometheus-prerecreate-2026-07-12_195512345.tar.gz" }
```

**Error (500):** `{ "error": "Pre-recreate backup failed, aborting: ..." }`

---

### `GET /api/agents/config-json`
Read the full `openclaw.json` from a running agent container (token masked).
Useful for inspecting the container config without SSH or terminal.

**Query params:** `name` (required) — Docker container name

**Response:**
```json
{
  "name": "my-agent",
  "config": {
    "gateway": { "controlUi": { "allowedOrigins": ["..."], "dangerouslyDisableDeviceAuth": true } },
    "agents": { "defaults": { "model": { "primary": "olympus/deepseek/deepseek-v4-flash", "fallbacks": [] } } },
    "models": { "providers": { "olympus": { "baseUrl": "...", "apiKey": "***", "models": [...] } } }
  }
}
```

**Error (404):** `{ "error": "Config file not found or empty in container" }`
**Error (400):** `{ "error": "name query param is required" }`

---

### `GET /api/agents/token`
Read the shared agents gateway token.

**Auth:** browser cookie

**Response:**
```json
{ "token": "asdfghjkl", "updated_at": 1751270000000 }
```

The token is stored in `data/agents-token.json`.

---

### `PUT /api/agents/token`
Update the shared agents gateway token and push it to all running agent containers.

**Auth:** browser cookie

**Body:**
```json
{ "token": "new-token-value" }
```

**Response:**
```json
{ "success": true, "containersUpdated": 2 }
```

**Side effects:**
- Writes the new token to `data/agents-token.json`
- Writes the token file (`/root/.agent-token`) into every running container with `AGENT_ID` label
- Restarts each container so the entrypoint picks up the new token via `OPENCLAW_GATEWAY_TOKEN` env

---

### `GET /api/agents-active`

### `GET /api/agents-active`
Configured agents (from `openclaw.json`) enriched with recent session activity
and workspace files.

**Auth:** browser cookie

**Response:**
```json
[
  {
    "agent_id": "ops",
    "label": "Argus",
    "config_model": "openai-codex/gpt-5.4",
    "workspace_path": "/data/.openclaw/workspace-ops/",
    "files": [ { "name": "MEMORY.md", "path": "...", "rel_path": "MEMORY.md", "type": "markdown" } ],
    "sessions": [ ...last 5 session rows... ],
    "status": "idle",
    "config": { ...raw agent config... }
  }
]
```

---

### `GET /api/agents-config`
Read agents, Telegram accounts, and bindings from `openclaw.json` (sanitized — no raw tokens).

**Auth:** browser cookie

**Response:**
```json
{
  "agents": [ { "id": "ops", "label": "Argus", "model": "..." } ],
  "telegramAccounts": [ { "accountId": "argus", "tokenStatus": "masked", "enabled": true } ],
  "bindings": [ { "bindingKey": "0", "type": "telegram", "agentId": "ops" } ]
}
```

---

### `POST /api/agents-config`
Update agents, Telegram accounts, or bindings. Writes to `openclaw.json` with atomic rename + backup.

**Auth:** browser cookie

**Body:**
```json
{
  "agents": [ { "currentId": "ops", "id": "ops", "name": "Argus" } ],
  "telegramAccounts": [],
  "bindings": []
}
```

**Response:** `{ "success": true, "data": { ...updated config payload... } }`

---

## Lineage

### `POST /api/lineage`
Register a parent→child relationship between sessions.

**Auth:** browser cookie or Bearer

**Body:**
```json
{ "childId": "agent:ops:subagent:uuid", "parentId": "agent:ops:main", "label": "Hygiene Agent" }
```

**Response:** `{ "ok": true, "childId": "...", "parentId": "...", "label": "Hygiene Agent" }`

**Error:** `400` if `childId` or `parentId` missing.

---

## Metrics

### `GET /api/metrics`
System metrics: latest snapshot + 24 h history + 24 h aggregates.

**Auth:** Bearer or browser cookie

**Response:**
```json
{
  "latest": { "ts": 1749201000000, "cpu_percent": 12.5, "ram_used_mb": 1820, "ram_total_mb": 4096, "disk_used_gb": 38.2, "disk_total_gb": 100.0, "load_avg_1m": 0.42 },
  "history": [ ...up to 288 rows (24h at 5min intervals)... ],
  "stats_24h": { "avg_cpu": 14.2, "max_cpu": 68.0, "avg_ram_mb": 1750 }
}
```

---

## System Health

### `GET /api/system-health`
Aggregated health checks with recommendations.

**Auth:** browser cookie

**Response:**
```json
{
  "health": "ok",
  "checks": [
    { "name": "daemon", "status": "ok", "detail": "last poll 18s ago" },
    { "name": "disk", "status": "warn", "detail": "82% used" }
  ],
  "recommendations": [ "Consider archiving old sessions to reduce disk usage." ],
  "generatedAt": 1749201500000
}
```

`health` values: `"ok"` / `"warn"` / `"error"`

---

## Crons

### `GET /api/crons`
List of scheduled cron jobs from the OpenClaw gateway.

**Auth:** Bearer or browser cookie

**Response:**
```json
[
  {
    "id": "eef708de-...",
    "name": "openclaw-hygiene-nightly",
    "schedule": "15 3 * * *",
    "model": "openai-codex/gpt-5.4-mini",
    "enabled": true,
    "lastRun": 1749100000000,
    "nextRun": 1749186000000
  }
]
```

---

## Memory & Context

### `GET /api/memory-context`
Memory context snapshot for the current agent workspace.

**Auth:** browser cookie

**Response:**
```json
{
  "files": [ { "path": "MEMORY.md", "sizeBytes": 13800, "lastModified": 1749200000000 } ],
  "totalBytes": 29800,
  "budgetBytes": 25600,
  "overBudget": true
}
```

---

## Workspace

Full design, decisions, and usage guide at [WORKSPACE.md](WORKSPACE.md).

### `GET /api/workspace?action=list`
List available workspaces (VPS host + Docker containers with `AGENT_ID` label).

**Auth:** Bearer, query param, x-agent-token, or browser cookie

**Response:**
```json
{
  "workspaces": [
    { "id": "vps", "label": "VPS Host (Nexus)", "type": "host" },
    { "id": "container-openclaw-atlas", "label": "atlas (openclaw-atlas)", "type": "container" }
  ]
}
```

### `GET /api/workspace?workspace=<id>`
List files in a workspace, read a file, or return a recursive tree payload.

**Auth:** any auth method

**Query params:** `workspace` (optional, defaults to `vps`), `path` (optional), `tree=1` (optional)

**Response (directory):**
```json
{
  "workspace": "vps",
  "label": "VPS Host (Nexus)",
  "path": "/path/to/workspace",
  "type": "host",
  "files": [
    { "name": "config", "isDirectory": true, "isFile": false, "path": "..." },
    { "name": "SOUL.md", "isDirectory": false, "isFile": true, "path": "..." }
  ]
}
```

**Response (file):** Same structure with `content` field instead of `files`.

### `PUT /api/workspace`
Write content to a workspace file.

**Auth:** any auth method

**Body:** `{ "workspace": "vps", "path": "/path/to/workspace/test.md", "content": "hello" }`

**Response:** `{ "ok": true }`

---

## Vault

Full key management documentation at [PROVIDERS.md](PROVIDERS.md).

### `GET /api/vault`
List all stored credentials (keys masked).

**Auth:** browser cookie

**Response:**
```json
{
  "providers": {
    "deepseek": { "keyStatus": "present", "scoped": ["atlas"] }
  },
  "services": {
    "github": { "tokenStatus": "present", "user": "Flame0510", "scoped": ["argus", "atlas"] }
  }
}
```

### `GET /api/vault/provider/key`
Return the full API key for a provider.

**Auth:** browser cookie

**Query params:** `provider` (required), `agent` (optional)

**Response (200):**
```json
{
  "provider": "deepseek",
  "apiKey": "sk-...full-key...",
  "masked": "sk-...be03",
  "source": "local"
}
```

**Error:** `400` if `provider` missing; `404` if key not found.

See [PROVIDERS.md](PROVIDERS.md#get-apivaultproviderkey) for full detail.

### `POST /api/vault/provider`
Add or update a provider API key.

**Auth:** browser cookie

**Body:** `{ "provider": "deepseek", "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" }`

**Response:** `{ "status": "ok", "provider": "deepseek", "masked": "sk-...be03", "updatedAt": 1749200000000 }`

### `DELETE /api/vault/provider`
Remove a provider and all its keys.

**Auth:** browser cookie

**Body:** `{ "provider": "deepseek" }`

**Response:** `{ "status": "removed" }`

### `PUT /api/vault/service`
Add or update a service token.

**Auth:** browser cookie

**Body:** `{ "id": "github", "token": "***", "user": "Flame0510", "scopes": ["atlas"] }`

**Response:** `{ "ok": true }`

### `DELETE /api/vault/service`
Remove a service.

**Auth:** browser cookie

**Body:** `{ "id": "github" }`

**Response:** `{ "ok": true }`

### `PUT /api/vault/permissions`
Update agent permissions for a credential.

**Body:** `{ "type": "provider" | "service", "id": "deepseek", "scopes": ["atlas", "argus"] }`

**Response:** `{ "ok": true }`

---

## Containers

### `GET /api/containers`
List all running Docker containers with resource usage.

**Auth:** browser cookie

**Response:**
```json
{
  "containers": [
    {
      "name": "openclaw-atlas",
      "image": "openclaw-agent-base:latest",
      "status": "running",
      "ports": ["0.0.0.0:3731->3000/tcp"],
      "created": "2026-06-20T10:00:00Z",
      "cpu_percent": 2.1,
      "mem_usage_mb": 340
    }
  ]
}
```

### `GET /api/containers/logs?name=<name>&tail=<lines>`
Get container logs.

**Auth:** browser cookie

**Query params:** `name` (required), `tail` (default 50)

**Response:** `{ "name": "openclaw-atlas", "logs": "[log lines...]" }`

### `POST /api/containers/action`
Execute action on a container.

**Body:** `{ "action": "restart" | "stop" | "start", "name": "openclaw-atlas" }`

**Response:** `{ "ok": true, "message": "Container openclaw-atlas restarted" }`

---

## Agent Providers

### `GET /api/agent-providers`
List provider configurations available across all agents.

**Auth:** browser cookie

**Response:** `{ "providers": [...] }`

---

## Tools

### `GET /api/tools-config`
Read audio/TTS and timezone tool configuration.

**Auth:** browser cookie

**Response:** `{ "audio": { ... }, "timezone": "Europe/Rome" }`

### `POST /api/tools-config`
Update audio or timezone config in `openclaw.json`.

**Body:** `{ "timezone": "America/New_York" }` or `{ "audio": { ... } }`

**Response:** `{ "ok": true, "timezone": "America/New_York", "audio": { ... } }`

---

## Providers

Full UI documentation at [PROVIDERS.md](PROVIDERS.md).

### `GET /api/providers`
AI provider configurations (keys masked — full keys never exposed here).

**Auth:** browser cookie

**Response:**
```json
{
  "providers": [
    { "id": "deepseek", "name": "DeepSeek", "keyStatus": "present", "models": ["deepseek/deepseek-v4-flash"] }
  ]
}
```

### `POST /api/providers/login`
Start, refresh, save, or disconnect provider authentication for the host or a target container.

**Auth:** browser cookie

**Body:**
```json
{
  "provider": "openai-codex",
  "agent": "openclaw-atlas",
  "method": "oauth",
  "apiKey": "...",
  "disconnect": false,
  "force": false
}
```

**Supported modes:**
- OAuth or refresh flow: `method: "oauth"` or `method: "refresh"`
- API key / setup token save: `method: "api-key"` with `apiKey`
- Disconnect: `disconnect: true`

**Response examples:**
```json
{ "status": "pending", "verificationUri": "https://auth.openai.com/codex/device", "userCode": "ABCD-1234" }
```

```json
{ "status": "already_connected" }
```

```json
{ "status": "tty_required", "message": "This provider OAuth requires a terminal. Run this command manually:", "command": "docker exec -it openclaw-atlas openclaw models auth login --provider openai-codex" }
```

```json
{ "status": "ok", "provider": "anthropic", "method": "setup-token" }
```

```json
{ "status": "disconnected", "method": "force-remove" }
```

**Notes:**
- If `agent` is omitted, the route updates the host's `~/.openclaw/agents/main/agent` files directly.
- For container-scoped operations it uses `docker exec`.
- Disconnect attempts also remove matching entries from `auth-profiles.json`, `models.json`, and the local SQLite profile store when possible.

### `POST /api/providers/device-code`
Start a device-code login flow for a supported provider.

**Auth:** browser cookie

**Body:**
```json
{ "provider": "openai-codex", "agent": "openclaw-atlas" }
```

**Response example:**
```json
{
  "status": "pending",
  "provider": "openai-codex",
  "agent": "openclaw-atlas",
  "deviceAuthId": "device_auth_id",
  "userCode": "ABCD-1234",
  "verificationUri": "https://auth.openai.com/codex/device",
  "intervalMs": 5000,
  "expiresAt": 1751270900000
}
```

**Notes:**
- Built-in device-code support currently exists for `openai-codex` and `github-copilot`.
- Unsupported providers fall back to `openclaw models auth login --device-code`; if that still cannot produce a code, the route returns `tty_required`.

### `GET /api/providers/device-code?provider=<id>&deviceAuthId=<id>&userCode=<code>&expiresAt=<unix_ms>`
Poll the device-code flow until authorization completes or expires.

**Auth:** browser cookie

**Response examples:**
```json
{ "status": "pending" }
```

```json
{ "status": "pending", "delayMs": 10000 }
```

```json
{
  "status": "completed",
  "provider": "openai-codex",
  "accessToken": "...",
  "refreshToken": "...",
  "expiresMs": 1751274500000
}
```

```json
{ "status": "timeout" }
```

**Notes:**
- Returns `missing_params` if required query parameters are absent.
- Returns `unsupported` for providers without built-in polling support.
- `openai-codex` performs a second token exchange step internally when the poll API returns `authorization_code` and `code_verifier`.

### `POST /api/providers/device-code/save`
Persist OAuth tokens obtained from the device-code flow.

**Auth:** browser cookie

**Body:**
```json
{
  "provider": "openai-codex",
  "accessToken": "...",
  "refreshToken": "...",
  "expiresMs": 1751274500000,
  "agent": "openclaw-atlas"
}
```

**Response examples:**
```json
{ "status": "ok", "profileId": "openai-codex:device", "method": "paste-token" }
```

```json
{ "status": "ok", "profileId": "openai-codex:device", "method": "files" }
```

**Notes:**
- If CLI token import fails, the route falls back to direct file writes.
- It updates both `auth-profiles.json` and `models.json`, then restarts the gateway process when possible.

---

## Version & WebSocket

### `GET /api/version`
Return the installed OpenClaw CLI version.

**Auth:** browser cookie

**Response:**
```json
{ "version": "openclaw x.y.z" }
```

**Fallback:** `{ "version": "unknown" }` if the command fails.

### `GET /api/ws`
Documentation placeholder for WebSocket access.

**Auth:** browser cookie

**Response:** plain text with HTTP `426 Upgrade Required`

Example body:
```text
WebSocket endpoint available at ws://HOST/ws. This route is a documentation placeholder and does not upgrade connections.
```

### `GET /ws`
Live WebSocket endpoint exposed by the custom server.

**Auth:** same browser session as the dashboard

**Protocol notes:**
- Hosted on the main HTTP port, not under `/api/`
- Accepts JSON messages such as `chat.send` and `chat.history`
- Intended for the dashboard client rather than generic REST consumers

---

## Plugins

### `GET /api/plugins`
List installed OpenClaw plugins.

**Auth:** browser cookie

**Response:** `{ "plugins": [ { "id": "file-transfer", "enabled": true, ... } ] }`

### `POST /api/plugins`
Enable or disable a plugin.

**Body:** `{ "action": "enable" | "disable", "pluginId": "file-transfer" }`

**Response:** `{ "ok": true }`

---

## Skills

### `GET /api/skills`
List available agent skills in the workspace.

**Auth:** browser cookie

**Response:** `{ "skills": [ { "name": "olympus", "path": "...", "description": "..." } ] }`

---

## Assistant (PYTHIA)

### `POST /api/assistant`
Chat with the built-in AI assistant (PYTHIA).

**Auth:** browser cookie

**Body:**
```json
{
  "message": "What can I do on the Agents page?",
  "page": "/agents",
  "model": "deepseek/deepseek-v4-flash",
  "history": []
}
```

| Field     | Type                    | Required | Description                                      |
|-----------|-------------------------|----------|--------------------------------------------------|
| `message` | string                  | yes      | The user's question                              |
| `page`    | string                  | no       | Current page path (used for contextual prompts)  |
| `model`   | string                  | no       | AI model to use (e.g. `deepseek/deepseek-v4-flash`) |
| `history` | `{role, content}[]`     | no       | Recent conversation history (up to 10 messages)  |

**Response:** `text/event-stream` (Server-Sent Events)

PYTHIA streams the assistant response as SSE chunks. Each chunk follows the
[OpenAI streaming format](https://platform.openai.com/docs/api-reference/chat/streaming):
```text
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"choices":[{"delta":{"content":"! How can"},"index":0}]}

data: [DONE]
```

**Errors:** JSON `{ "error": "..." }` with the appropriate HTTP status code.

**Notes:**
- PYTHIA routes the request **directly to the upstream provider** (not via the local Provider Gateway), using the API key from `data/provider-keys.json`.
- The system prompt is built dynamically based on `PAGE_CONTEXT` (hardcoded in the route handler) — no database access.
- PYTHIA does **not** have access to live data; she only knows page descriptions and navigation links.

---

## Credentials

### `GET /api/credentials`
List all stored credential profiles and the provider registry.

**Response:** `{ profiles: CredentialProfile[], providers: CredentialProviderDef[] }`

### `POST /api/credentials`
Create a new credential profile.

**Body:** `{ providerId: string, label: string, secret: Record<string, string> }`

**Response:** `{ id: string }` (201)

### `GET /api/credentials/[id]`
Get a single credential profile (no secret returned).

### `PATCH /api/credentials/[id]`
Update label and/or secret of a credential.

**Body:** `{ label: string, secret: Record<string, string> }`

### `DELETE /api/credentials/[id]`
Delete a credential and its secret permanently.

### `POST /api/credentials/[id]/sync`
Sync the credential to all agent containers (or a specified subset).

**Body (optional):** `{ containers?: string[] }` — if omitted or empty, syncs to all agent containers with `AGENT_ID` labels.

**Response:** `{ results: { container: string, status: 'ok'|'error', error?: string }[] }`

Before syncing, **all agent containers are cleaned first** (env files, CLI auth, TOOLS.md integration markers removed).
Only the selected containers receive the new credential and TOOLS.md section.
This ensures that deselecting an agent or deleting a profile removes the credential from all agents.

### `GET /api/credentials/detect`
Live-detect which credentials are actually present inside agent containers.

**Query params (optional):** `?agent=prometheus` — filter to a single container.

**Response:**
```json
{
  "agents": [
    {
      "container": "prometheus",
      "agentId": "prometheus",
      "githubLoggedIn": true,
      "githubUser": "Flame0510",
      "githubCliInstalled": true,
      "vercelLoggedIn": false,
      "vercelUser": "",
      "vercelTeam": "",
      "vercelCliInstalled": true,
      "supabaseLoggedIn": true,
      "supabaseLinked": false,
      "supabaseProjectRef": "",
      "supabaseCliInstalled": true,
      "trelloLoggedIn": false,
      "trelloCliInstalled": true,
      "toolsMdHasMarkers": true,
      "matchedProfiles": [
        { "profileId": "cred_xxx", "providerId": "github-pat", "label": "GitHub" }
      ]
    }
  ]
}
```

Detection runs `docker exec` inside each container:
- `gh auth status` for GitHub (token read from `~/.config/gh/hosts.yml`)
- `vercel whoami` for Vercel (token read from `~/.local/share/com.vercel.cli/auth.json`)
- `supabase projects list --output json` for Supabase (token read from `~/.supabase/access-token`)
- `test -f ~/.trello-cli/default/config.json` for Trello
- TOOLS.md markers at `/root/.openclaw/workspace/TOOLS.md`

`matchedProfiles` is determined by SHA256-hashing the token installed in the container
and comparing it against the hashed token of each stored profile in the vault.
Only exact token matches produce a match — no heuristics, no broad profile-level guesses.

### `POST /api/credentials/[id]/reveal`
Return the raw secret payload. Every call is logged in the audit trail.
Use sparingly.

**Response:** `{ secret: Record<string, string> }`

---

## Error Format

All errors return JSON:
```json
{ "error": "description of what went wrong" }
```

Common status codes: `400` bad request, `401` unauthorized, `404` not found, `500` server error.
