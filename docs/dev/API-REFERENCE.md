# Olympus API Reference

> **Last updated:** 2026-07-19

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

## Onboarding

### `GET /api/onboarding/status`
Returns per-step onboarding progress.

**Auth:** browser cookie

**Response:**
```json
{
  "complete": false,
  "steps": { "welcome": true, "providers": false, "agents": false },
  "completedAt": null
}
```

If no progress file exists, returns all steps as `false`.

### `POST /api/onboarding/complete`
Mark a step as completed, complete all steps, or reset the wizard.

**Auth:** browser cookie

**Body:**
| Shape | Effect |
|---|---|
| `{ "step": "providers" }` | Mark a single step as done |
| `{}` | Mark all steps as done (complete onboarding) |
| `{ "reset": true }` | Reset all steps to `false` (restart wizard) |

**Response:**
```json
{
  "status": "ok",
  "steps": { "welcome": true, "providers": true, "agents": false },
  "complete": false
}
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
    "traefikUrl": "http://203.0.113.10:3033#token=asdfghjkl"
  }
]

**Notes:**
- The URL is always `http://<host-ip>:<port>#token=...` (every agent gets a host port mapping)
- The `authToken` uses the shared gateway token from `data/agents-token.json`
- Containers are discovered via Docker API with label filter `AGENT_ID`
- Template is inferred from the container image name + agent ID directory match in `agent-templates/`

---

### `POST /api/agents/create`
Create a new agent container from a template.

**Auth:** browser cookie

**Body:**
```json
{
  "name": "my-agent",
  "template": "prometheus",
  "portRange": "3700-3709",
  "model": "deepseek/deepseek-v4-flash",
  "fallbacks": []
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Container name, also becomes `AGENT_ID` and subdomain |
| `template` | yes | Template name (directory in `agent-templates/`) |
| `portRange` | no | Optional port range (e.g. `3700-3709`) or single port (e.g. `3700`). Default: auto-assigned 10-port block |
| `model` | no | Primary model ID from `models.config.json` |
| `fallbacks` | no | Array of fallback model IDs |

**Every agent is created with a host port mapping:**
- Port block: `-p <start>-<end>:3000-<3000+offset>` — maps a range of host ports to the same range starting at container port 3000
- Single port: `-p <port>:3000` — maps a single host port to container port 3000
- URL format: `http://<host-ip>:<portStart>#token=...`
- Port 3740 is reserved for Olympus

**Response:**
```json
{
  "success": true,
  "containerId": "00f5de1eb08d...",
  "name": "my-agent",
  "image": "openclaw-agent-base:latest",
  "network": "olympus-network",
  "traefikUrl": "http://203.0.113.10:3700#token=asdfghjkl",
  "port": 3700,
  "portEnd": 3709,
  "isBlock": true,
  "portDisplay": "3700-3709"
}
```

**Post-creation pipeline:**
1. OpenClaw gateway starts with `--allow-unconfigured`, generating its own default config
2. The route waits for the gateway to be fully up (health check poll, up to 60 s)
3. Once ready, writes `gateway.controlUi.allowedOrigins` + `agents.defaults.model.primary` + fallbacks
4. Writes `models.providers.olympus` + extraDirs + update config → single `openclaw.json` write → single `gateway restart`

> **Note:** The entrypoint no longer generates `openclaw.json`. All post-creation config is written by the create route after gateway readiness, eliminating the race condition where the entrypoint would overwrite synced provider config.

**Side effects:**
- Template files (`AGENTS.md`, `SOUL.md`, etc.) are copied into the container workspace via `docker cp`
- The agent URL is included in the response
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
3. After startup, `applyRuntimeConfig()` (from `lib/agent-setup.ts`) guarantees:
   - `hooks.bootstrap-extra-files` (Olympus system rules injection)
   - `skills.load.extraDirs` (shared skills discovery)
   - `models.providers.olympus` (provider proxy, host-dependent)
   All patches use `config patch --stdin` (deep-merge) — existing user
   customizations are never overwritten.

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

## Channels

Channel APIs read/write agent channel configuration (Telegram) directly inside agent containers via `docker exec`. All endpoints require the agent container to be running.

### `GET /api/agents/[id]/channels`
Get channel configuration for an agent.

**Auth:** browser cookie

**Response:**
```json
{
  "agentId": "atlas",
  "telegram": {
    "connected": true,
    "botToken": "1234...5678",
    "dmPolicy": "pairing",
    "allowFrom": ["123456789"]
  }
}
```

- `telegram` is `null` if not configured
- `botToken` is masked (first 4 + last 4 chars)
- `allowFrom` lists approved sender IDs

---

### `PUT /api/agents/[id]/channels/telegram`
Connect Telegram to an agent by saving a bot token.

**Auth:** browser cookie

**Body:**
```json
{
  "botToken": "1234567890:ABCdefGHIjklMNOpqrsTUVwxyz"
}
```

| Field | Required | Description |
|---|---|---|
| `botToken` | yes | Bot token from @BotFather |

**Response (200):** `{ "success": true }`

**Response (400):** `{ "error": "botToken is required" }`

**Response (404):** `{ "error": "Agent container not found: ..." }`

**Side effects:**
- Writes `channels.telegram.botToken` and `channels.telegram.dmPolicy: "pairing"` to `/root/.openclaw/openclaw.json`
- Creates a binding for this agent → telegram channel
- If the token changed, wipes previous pairing data
- The agent must be restarted for the gateway to pick up the new config

---

### `DELETE /api/agents/[id]/channels/telegram`
Disconnect Telegram from an agent.

**Auth:** browser cookie

**Response (200):** `{ "success": true }`

**Response (404):** `{ "error": "Agent container not found: ..." }`

**Side effects:**
- Sets `channels.telegram.enabled: false`, removes `botToken` and `allowFrom`
- Removes the telegram binding
- Deletes pairing files (`telegram-pairing.json`, `telegram-default-allowFrom.json`)
- No restart required

---

### `GET /api/agents/[id]/channels/pairing?channel=telegram`
Get pending and approved pairings for a channel.

**Auth:** browser cookie

**Query params:**
| Param | Required | Description |
|---|---|---|
| `channel` | no | Channel name (default: `telegram`) |

**Response:**
```json
{
  "pending": [
    { "code": "A1B2", "senderId": null }
  ],
  "approved": [
    { "senderId": "123456789" }
  ]
}
```

- Pending codes are from `openclaw pairing list --json`
- Approved senders are from the credentials allowFrom file

---

### `POST /api/agents/[id]/channels/pairing?channel=telegram`
Approve a pending pairing code.

**Auth:** browser cookie

**Query params:**
| Param | Required | Description |
|---|---|---|
| `channel` | no | Channel name (default: `telegram`) |

**Body:**
```json
{ "code": "A1B2" }
```

**Response (200):** `{ "success": true }`

**Response (400):** `{ "error": "Pairing code is required" }`

**Response (404):** `{ "error": "..." }`

---

### `DELETE /api/agents/[id]/channels/pairing?channel=telegram&senderId=123456789`
Revoke an approved sender.

**Auth:** browser cookie

**Query params:**
| Param | Required | Description |
|---|---|---|
| `channel` | no | Channel name (default: `telegram`) |
| `senderId` | yes | Sender ID to revoke |

**Response (200):** `{ "success": true }`

**Response (400):** `{ "error": "senderId query param is required" }`

---

### `GET /api/agents/channels-summary`
Lightweight channel status for all running agents (used for TG chips on the agent list).

**Auth:** browser cookie

**Response:**
```json
{
  "atlas": { "telegram": true },
  "prometheus": { "telegram": false }
}
```

- Only includes agents with `AGENT_ID` Docker label
- `telegram: true` means the channel is connected and configured
- Cached for 15 seconds (maxDuration)

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

## Agent Image Management

### `GET /api/agents/image-status`
Check the status of the `openclaw-agent-base` Docker image.

**Auth:** public (no auth required)

**Response:**
```json
{
  "exists": true,
  "needsUpdate": false,
  "downloading": false,
  "localId": "sha256:a1b2c3d4e5f6..."
}
```

| Field | Description |
|---|---|
| `exists` | Whether `openclaw-agent-base:latest` exists locally |
| `needsUpdate` | `true` if local image has no matching registry digest |
| `downloading` | Whether a download is currently running |
| `localId` | SHA256 ID of the local image, or null |

### `POST /api/agents/download-image`
Starts pulling or building the `openclaw-agent-base:latest` image. Returns 202
Accepted immediately — the operation runs in the background and writes logs.
The frontend polls `GET /api/agents/image-status` for progress updates.

**Auth:** public (no auth required)

**Response (202):**
```json
{ "status": "downloading" }
```

**Error (409):**
```json
{ "error": "A download is already in progress" }
```

### `DELETE /api/agents/abort-download`
Kills an in-progress docker pull/build.

**Auth:** public (no auth required)

**Response:**
```json
{ "aborted": true }
```

Image state is managed in `lib/buildAgentImage.ts`:
- `downloadAgentImage(opts)` — attempts `docker pull` from registry first, then falls back to `docker build`
  all stdout/stderr to a log file, supports optional `onEvent` callback and `AbortSignal`
- `abortDownload()` — sends SIGKILL to the child process, releases the download lock
- `getDownloadLogPath()` — returns the path to the current/last download log file
- `getIsDownloading()` — checks the in-memory lock flag

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
List of scheduled cron jobs from the host OpenClaw gateway (via `openclaw cron list --json`) and every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`).

Jobs from agent containers include `containerName` and `source: "container"` fields.
Jobs from the host gateway have `source: "host"`.

**Auth:** Bearer or browser cookie

**Response:**
```json
[
  {
    "id": "eef708de-...",
    "name": "openclaw-hygiene-nightly",
    "description": "Nightly workspace cleanup",
    "schedule": "15 3 * * *",
    "scheduleExpr": "15 3 * * *",
    "model": "openai-codex/gpt-5.4-mini",
    "enabled": true,
    "source": "host",
    "state": {
      "lastStatus": "ok",
      "lastRunAtMs": 1749100000000,
      "nextRunAtMs": 1749186000000
    },
    "computedNextRunAtMs": 1749186000000,
    "createdAtMs": 1748000000000
  },
  {
    "id": "c1b3e47f-...",
    "name": "atlas-weekly-report",
    "schedule": "0 9 * * 1",
    "enabled": true,
    "source": "container",
    "agentId": "atlas",
    "containerName": "openclaw-atlas",
    "computedNextRunAtMs": 1749600000000
  }
]
```

### `PATCH /api/crons/[id]`
Update a cron job. Only the `enabled` field can be patched.

For jobs inside a container, pass `containerName` in the body to identify which container to write to.

**Auth:** Bearer or browser cookie

**Body:**
```json
{
  "enabled": false
}
```

**Body (container cron):**
```json
{
  "enabled": false,
  "containerName": "openclaw-atlas"
}
```

**Response:**
```json
{
  "id": "eef708de-...",
  "name": "openclaw-hygiene-nightly",
  "enabled": false,
  "scheduleExpr": "15 3 * * *"
}
```

### `DELETE /api/crons/[id]`
Remove a cron job permanently. For jobs inside a container, pass `containerName` as a query parameter.

**Auth:** Bearer or browser cookie

**Query params:**
- `containerName` (optional) — Docker container name for container-scoped jobs

**Response:**
```json
{ "ok": true }
```

**Error (404):** `{ "error": "Job ... not found" }`
**Error (502):** `{ "error": "Failed to remove cron job in container ..." }`

### `GET /api/crons/runs`
Run history for a specific cron job. Queries the container's gateway via `openclaw cron runs --id <jobId> --limit <limit>`.

**Auth:** Bearer or browser cookie

**Query params:**
- `containerName` (required) — Docker container name
- `jobId` (required) — cron job UUID
- `limit` (optional, default 20, max 100) — number of recent runs to return

**Response:**
```json
{
  "entries": [
    {
      "ts": 1784820036635,
      "jobId": "7a607208-...",
      "action": "finished",
      "status": "error",
      "error": "Channel is required ...",
      "runAtMs": 1784820025581,
      "durationMs": 11046,
      "model": "deepseek/deepseek-v4-flash",
      "usage": { "input_tokens": 15872, "output_tokens": 597 }
    }
  ]
}
```

On gateway-connection failure:
```json
{ "error": "Cannot connect to container gateway for runs", "entries": [] }
```
(HTTP 502)

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

Skill discovery across three sources:
- **Shared:** skills in `/docker/shared-skills` on the VPS host (global, available to all agents)
- **Workspace:** skills in `<workspace>/skills` inside each agent container (discovered via `docker exec`)
- **Bundled:** skills shipped with OpenClaw (read-only)

### `GET /api/skills`
List all available skills from all sources.

**Auth:** browser cookie

**Response:**
```json
{
  "skills": [
    {
      "name": "code-review",
      "type": "shared",
      "path": "/docker/shared-skills/code-review",
      "skillMdPath": "/docker/shared-skills/code-review/SKILL.md",
      "hasSkillMd": true,
      "description": "Systematic code review patterns...",
      "version": "1.0"
    },
    {
      "name": "my-custom-skill",
      "type": "workspace",
      "agentId": "atlas",
      "containerName": "openclaw-atlas",
      "path": "/root/.openclaw/workspace/skills/my-custom-skill",
      "skillMdPath": "/root/.openclaw/workspace/skills/my-custom-skill/SKILL.md",
      "hasSkillMd": true,
      "description": "Custom agent skill"
    }
  ]
}
```

### `GET /api/skills/save?path=<path>[&containerName=<name>]`
Read a SKILL.md file. For container skills, pass `containerName`.

**Auth:** browser cookie

**Response:** `{ "content": "---\nname: my-skill\n..." }`

### `POST /api/skills/save`
Write a SKILL.md file. Supports shared directory and container workspaces.

**Auth:** browser cookie

**Body:**
```json
{
  "skillPath": "/root/.openclaw/workspace/skills/my-skill/SKILL.md",
  "content": "---\nname: my-skill\n...",
  "containerName": "openclaw-atlas"
}
```
- `containerName` is required for container skills, omitted for shared/host skills
- Bundled skills are read-only

**Response:** `{ "ok": true, "saved": "..." }`

### `POST /api/skills/promote`
Copy a skill from an agent's workspace to the shared skills directory, making it available to all agents.

**Auth:** browser cookie

**Body:**
```json
{
  "containerName": "openclaw-atlas",
  "skillName": "my-custom-skill"
}
```

**Response:**
```json
{
  "ok": true,
  "skillName": "my-custom-skill",
  "agentId": "atlas",
  "containerName": "openclaw-atlas",
  "destPath": "/docker/shared-skills/my-custom-skill",
  "overwritten": false,
  "extraCopied": 0
}
```

- `overwritten`: `true` if a shared skill with the same name already existed
- `extraCopied`: number of additional files (beyond SKILL.md) copied from the skill directory
- The skill name is validated against `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`
- Container must have an `AGENT_ID` Docker label

### `DELETE /api/skills/delete`
Delete a skill from shared skills directory or from an agent's workspace.

**Auth:** browser cookie

**Body (shared skill):**
```json
{
  "skillName": "my-custom-skill"
}
```

**Body (workspace/container skill):**
```json
{
  "skillName": "my-custom-skill",
  "containerName": "openclaw-atlas"
}
```

**Response:**
```json
{
  "ok": true,
  "skillName": "my-custom-skill",
  "deleted": true,
  "from": "shared"
}
```

- `from` is either `"shared"` or `"workspace"`
- Bundled skills cannot be deleted (read-only)
- The skill name is validated against the same regex as promote

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
