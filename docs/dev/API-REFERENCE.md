# Rev4a API Reference

> **Last updated:** 2026-09-14

All routes are under `/api/`. Authentication is required on every endpoint
unless otherwise noted.

---

## Authentication

### Bearer token (programmatic)
```
Authorization: Bearer <REV4A_TOKEN>
```
Set `REV4A_TOKEN` env var. No default — auth is disabled when unset.

### Browser cookie (UI)
After a successful `POST /api/auth/login`, the server sets an `rev4a_token`
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
Sets `Set-Cookie: rev4a_token=<jwt>; HttpOnly; SameSite=Lax`.

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
Delete the `rev4a_token` cookie.

**Auth:** browser cookie

**Response:**
```json
{ "ok": true }
```

---

### `GET /api/auth/status`
Whether a password has been configured, in the environment or in the `.env` the
setup wizard writes. Used by the frontend to choose between the setup wizard and
the login form.

**Auth:** none — it reveals only whether setup has happened, never the password

**Response:** `{ "configured": true }`

---

## Setup & wizard

### `GET /api/wizard/status`
Whether the first-run wizard has been completed.

**Auth:** browser cookie or bearer token

**Response:** `{ "done": true }`

### `POST /api/wizard/complete`
Mark the wizard as completed.

**Auth:** browser cookie or bearer token

**Response:** `{ "done": true }`

### `POST /api/wizard/reset`
Reset the wizard so it runs again.

**Auth:** browser cookie or bearer token

**Response:** `{ "done": false }`

---

### `POST /api/setup/password`
Set the dashboard password during first-run setup.

**Auth:** none, and only usable once — returns `409` if a password already exists

**Body:** `{ "password": "..." }` — minimum 8 characters

**Errors:** `400` invalid JSON, missing password, or shorter than 8 characters;
`409` already configured; `500` the `.env` file could not be written.

**Response:** `{ "status": "ok" }`

### `POST /api/setup/restart`
Restart the service so a freshly written `.env` takes effect.

**Auth:** open before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Errors:** `500` if the `.env` file is missing, or the restart could not be issued.

### `GET /api/setup/agent-image`
Whether the `openclaw-agent-base` image is present.

**Auth:** open before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Response:** `{ "exists": true, "imageId": "sha256:..." }`, or `{ "exists": false }`
when the image is absent **or Docker is unreachable** — the two are not distinguished.

### `POST /api/setup/agent-image`
Pull or build the agent base image, streaming progress.

**Auth:** open before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Errors:** `409` if a download is already running.

---

## Gateway

The Gateway API reads the model catalogue from [`models.config.json`](../../models.config.json)
(tracked in the repository). Full documentation at [GATEWAY.md](GATEWAY.md) and
[PROVIDERS.md](PROVIDERS.md).

### `PUT /api/gateway/provider`
Enable or disable a single model in the catalogue, then sync every agent.

**Auth:** browser cookie or bearer token

**Body:** `{ "modelId": "deepseek/deepseek-flash", "enabled": true }` — both
required. Missing either returns `400`; an unknown `modelId` returns `404`.
If Docker cannot be reached the toggle is refused with `503` and nothing is saved,
so a whole-fleet outage never leaves the checkboxes out of step with the agents.

**Response:** `status` is the toggle, which is saved before the sync runs. `sync`
reports separately whether the agents received it.
```json
{
  "status": "ok",
  "modelId": "deepseek/deepseek-flash",
  "enabled": true,
  "provider": "deepseek",
  "sync": {
    "ok": true,
    "activeModels": 3,
    "total": 2,
    "synced": ["agent_2a3c3a07", "agent_9253eee3"],
    "stopped": [],
    "failed": [],
    "summary": "Synced 2 of 2 agent(s)."
  }
}
```

`sync.ok` is true only when every agent container received the catalogue; zero
agents counts as ok. "Every" includes agents that are not running (stopped, paused,
created): they are written through `docker cp`, listed in `stopped` as well as
`synced`, and apply the change when started or resumed. A container whose config
cannot be read is listed in `failed` and left untouched — the sync never writes a
config it did not read. When Docker cannot be reached, `total` is `0`, `dockerError`
carries the cause and `ok` is false. For this toggle that case is refused up front
with `503`, so it appears here only if Docker drops between the check and the sync;
on a provider key save (`POST`) it is reported, not refused. `configError` is set,
and nothing is attempted, when the gateway key is missing or `models.config.json`
could not be read.

**Side effects:**
- Writes `models.providers.rev4a` to each agent container's `openclaw.json`
- Cleans up stale `models.json` and `auth-profiles.json` inside containers
- **Does NOT touch `agents.defaults.model` or `agents.list[].model`** — model references are managed per-container from the agent detail panel (`PUT /api/gateway/agent`)
- Does NOT restart the gateway (config is written live to the file)

### `PUT /api/gateway/agent`
Update the primary model and fallbacks of a single agent container.

**Auth:** any auth method

**Body:**
```json
{
  "containerName": "openclaw-atlas",
  "model": "deepseek/deepseek-flash",
  "fallbacks": ["deepseek/deepseek-v4-pro"]
}
```
`fallbacks` omitted and `fallbacks: []` are different requests. Omitted leaves the
container's existing fallbacks untouched; `[]` clears them.

`containerName` is used verbatim as the `docker exec` target, not resolved from the
`AGENT_ID` label. Every container's name currently equals its label, so an agent id
works.

**Response:** reports what was written, with the `rev4a/` prefix applied.
```json
{
  "status": "ok",
  "agent": "openclaw-atlas",
  "model": {
    "primary": "rev4a/deepseek/deepseek-flash",
    "fallbacks": ["rev4a/deepseek/deepseek-v4-pro"]
  },
  "verify": { "ok": true, "bytes": 2058 }
}
```

**Behaviour:**
- Writes `agents.defaults.model`, and the entry in `agents.list` whose `id` is
  `main` (skipped if there is none), both as `{ primary, fallbacks }`. The primary is
  removed from its own fallback list.
- Rewrites the whole `openclaw.json` with `docker exec … cat >`. No gateway restart:
  OpenClaw hot-applies the change.
- Does not check the model against the catalogue. The proxy does that when the model
  is used, so a model saved here while disabled is refused at request time.

### `GET /api/gateway/provider`
Returns current provider configuration state.

**Auth:** any auth method

**Query params:**
| Param | Effect |
|---|---|
| `summary=1` | Returns only `{ provider, label, configured }` per provider — no `models`, no `pricing`, no `apiKey`. The full response awaits live pricing from OpenRouter, a network round trip costing ~2.4s on a cold cache; callers that only need to know whether *any* provider is configured should use this. |

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
        { "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash", "enabled": true },
        { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "enabled": true }
      ]
    }
  ]
}
```

### `GET /api/provider/v1/models`

Rev4a Provider Gateway — returns the models this deployment offers (enabled after
overrides, provider has a key). A missing or wrong token gets an empty list, not a 401.

**Auth:** Bearer token (must match `rev4a` key in `data/provider-keys.json`)

**Response (authenticated):**
```json
{
  "object": "list",
  "total": 9,
  "data": [
    { "id": "deepseek/deepseek-flash", "object": "model", "created": 1700000000, "owned_by": "deepseek", "permission": [], "root": "deepseek/deepseek-flash" }
  ]
}
```

**Response (unauthenticated):**
```json
{ "object": "list", "total": 0, "data": [] }
```

### `POST /api/provider/v1/chat/completions`

A model the deployment does not offer is refused with `400` before anything reaches
upstream. Routing fields that would let the upstream choose another model — `models`,
`route`, `preset` — are removed from the body before forwarding.

Rev4a Provider Gateway — proxy chat completions to the correct upstream.

**Auth:** Bearer token (must match `rev4a` key in `data/provider-keys.json`)

**Body:**
```json
{
  "model": "rev4a/deepseek-flash",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

**Error (401):**
```json
{ "error": { "message": "Invalid API key...", "type": "authentication_error" } }
```

---

### `GET /api/models`
Models eligible to be used: the catalogue filtered down to models that are enabled
(after overrides) and whose provider has a key configured, grouped by provider. Feeds the model pickers in the agent's
Model panel.

**Auth:** browser cookie or bearer token

**Response:**
```json
[
  {
    "provider": "DeepSeek",
    "emoji": "🧠",
    "models": [
      {
        "id": "deepseek/deepseek-flash",
        "label": "DeepSeek Flash (V4.1)",
        "input": 0.3,
        "output": 1.2,
        "deprecated": false
      }
    ]
  }
]
```

`input` and `output` are USD per 1M tokens, `null` when unpriced. `deprecated`
marks a name upstream has retired; it stays selectable and the pickers tag it.
See [GATEWAY.md](GATEWAY.md) for the deprecation lifecycle.

### `GET /api/gateway/provider/balance`
Remaining credit for one provider.

**Auth:** browser cookie or bearer token

**Query params:** `provider` — one of `deepseek`, `openrouter`, `glm`.

**Errors:** `502` when the provider's API cannot be reached or rejects the call.

### `POST /api/gateway/provider/oauth`
Run the OAuth device flow for a provider that supports it.

**Auth:** browser cookie or bearer token

**Body:** `{ "provider": "..." }`

**Errors:** `400` for an unknown provider; the response body carries `available`
with the providers that do support OAuth.

### `POST /api/aliases/add`
Add a model alias.

**Auth:** browser cookie or bearer token

**Body:** `{ "alias": "fast", "model": "deepseek/deepseek-chat" }`

**Response:** `{ "ok": true, "output": "..." }` — `output` is the CLI's stdout.

**Errors:** `400` if `alias` or `model` is missing.

### `POST /api/aliases/remove`
Remove a model alias.

**Auth:** browser cookie or bearer token

**Body:** `{ "alias": "fast" }`

**Response:** `{ "ok": true, "output": "..." }`

**Errors:** `400` if `alias` is missing.

---

## Config

### `PUT /api/config/env`
Update environment variables on the VPS host.

**Auth:** browser cookie

**Body:** `{ "REV4A_PASSWORD": "newpass", ... }`

**Side effects:**
- Writes to `.env` in the project root
- Automatically syncs to `/etc/systemd/system/rev4a.service` (removes all `Environment=REV4A_*` and `Environment=PROVIDER_*` lines, appends current vars)
- Runs `systemctl daemon-reload` so the next restart picks up the new environment
- Only keys prefixed with `REV4A_` or `PROVIDER_` are accepted

**Response:** `{ "status": "ok", "updated": ["REV4A_PASSWORD", ...] }`

**Error (400):** `{ "error": "Keys not allowed: ..." }`

### `POST /api/config/restart`
Restart the Rev4a server (via systemd).

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

### `GET /api/sessions/[id]`
One session with its events and any child sessions.

**Auth:** browser cookie or bearer token

**Response:** `{ "session": {…}, "events": [...], "children": [...] }`

**Errors:** `404` if the session does not exist.

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
      "path": "/path/to/workspace/rev4a/README.md",
      "rel_path": "rev4a/README.md",
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
    "env": ["AGENT_ID=prometheus", "AGENT_TEMPLATE=prometheus"],
    "authToken": "***",
    "controlPort": "3033"
  }
]
```

**Notes:**
- The URL is always `http://<host-ip>:<port>#token=...` (every agent gets a host port mapping)
- The `authToken` uses the shared gateway token from `data/agents-token.json`
- Containers are discovered via Docker API with label filter `AGENT_ID`
- Template is inferred from the container image name + agent ID directory match in `agent-templates/`

---

### `GET /api/agents/models-summary`
One row per agent container, running or not: the model it runs and whether that
model is still in good standing. Feeds the model chip on the agent cards. Running
agents are read with `docker exec`, others with `docker cp`. If Docker cannot be
reached the route answers `503` with an `error`, not an empty list.

**Auth:** any auth method

**Response:**
```json
{
  "agents": [
    {
      "agentId": "atlas",
      "containerName": "openclaw-atlas",
      "primary": "rev4a/deepseek/deepseek-flash",
      "fallbackCount": 0,
      "firstFallback": null,
      "health": "ok"
    }
  ]
}
```

`health`, ordered by the remedy each needs:

| value | meaning | remedy |
|---|---|---|
| `missing` | the primary is not in the catalogue at all | pick another model |
| `disabled` | in the catalogue but not offered — unchecked, or its provider has no key; the proxy refuses it | pick another model |
| `out-of-sync` | offered by the gateway, absent from this container's synced copy | Sync All Agents |
| `deprecated` | works, on a name upstream has retired | switch when convenient |
| `ok` | usable | — |
| `unset` | no primary configured | — |
| `unknown` | the container did not answer | — |

### `GET /api/agents/[id]/model`
The model configuration of one agent, read from that container alone rather than
by walking the fleet. Writes still go to `PUT /api/gateway/agent`.

**Auth:** any auth method

**Response:**
```json
{
  "agentId": "atlas",
  "reachable": true,
  "primary": "rev4a/deepseek/deepseek-flash",
  "fallbacks": [],
  "resolvable": true,
  "catalogueSize": 41,
  "primaryStatus": "offered"
}
```

`resolvable` is tri-state. `false` means the primary is absent from the catalogue
synced into that container, usually because the model was disabled on the Gateway
page while this agent still pointed at it. `true` means it is present. `null` means
the question does not apply: either the container did not answer, or no primary is
set.

When `reachable` is `false` the container did not answer, `primary` and `fallbacks`
come back empty rather than read, and **`catalogueSize` is omitted entirely** — it
is present only on the reachable branch.

`primaryStatus`, also reachable branch only, says why the primary would fail
regardless of this container: `offered`, `disabled` (unchecked, or its provider has
no key) or `missing` (no longer in the catalogue). `null` when no primary is set.
`resolvable` answers a different question — whether *this container's* synced copy
has it — so `offered` with `resolvable: false` means the container is out of sync.

### `POST /api/agents/create`
Create a new agent container from a template.

**Auth:** browser cookie

**Body:**
```json
{
  "name": "my-agent",
  "template": "prometheus",
  "portRange": "3700-3709",
  "model": "deepseek/deepseek-flash",
  "fallbacks": []
}
```

| Field | Required | Description |
|---|---|---|
| `name` | yes | Container name, also becomes `AGENT_ID` and subdomain |
| `template` | yes | Template name (directory in `agent-templates/`) |
| `portRange` | no | Optional port range (e.g. `3700-3709`) or single port (e.g. `3700`). Default: auto-assigned 10-port block |
| `model` | no | Primary model id. Must be offered by this deployment (in the catalogue, enabled, provider has a key), in any form the proxy accepts; otherwise `400`. Defaults to `rev4a/deepseek/deepseek-flash`, validated the same way |
| `fallbacks` | no | Array of fallback model IDs |

**Every agent is created with a host port mapping:**
- Port block: `-p <start>-<end>:3000-<3000+offset>` — maps a range of host ports to the same range starting at container port 3000
- Single port: `-p <port>:3000` — maps a single host port to container port 3000
- Control UI URL: composed by the browser as `http://<window.location.hostname>:<port>#token=<controlToken>` — the server returns the parts, not the URL
- Port 3740 is reserved for Rev4a

**Response:**
```json
{
  "success": true,
  "containerId": "00f5de1eb08d...",
  "name": "my-agent",
  "image": "openclaw-agent-base:latest",
  "network": "rev4a-network",
  "controlToken": "asdfghjkl",
  "port": 3700,
  "portEnd": 3709,
  "isBlock": true,
  "portDisplay": "3700-3709"
}
```

**Post-creation pipeline:**
1. OpenClaw gateway starts with `--allow-unconfigured`, generating its own default config
2. The route waits for the gateway to finish starting (`waitForGatewayReady`, up to 60 s)
3. Once ready, rewrites `openclaw.json` in one write — `gateway.controlUi`,
   `agents.defaults.model` (primary and fallbacks, always as `rev4a/<provider>/<model>`)
   and `update` — then runs `openclaw gateway restart`
4. Applies the runtime config (hooks, shared skills) and writes `models.providers.rev4a`
   with `openclaw config patch --stdin`. No restart for this step: `gateway.reload`
   defaults to `hybrid`, which hot-applies changes under `agents`, `models` and
   `routing`. If the catalogue cannot be read the provider patch is skipped and logged

Failures in steps 3 and 4 do not fail the request.

**Side effects:**
- Template files (`AGENTS.md`, `SOUL.md`, etc.) are copied into the container workspace via `docker cp`
- The agent URL is included in the response
- An event is logged to `data/events.db` if available

**Error:** `400` for validation errors, `409` if name/port already in use

---

### `DELETE /api/agents/[id]`
**Destructive.** Permanently deletes the agent: the container, its persistent
volume (`agent-<id>-data`), and **all** its backups (`agent-<id>-*.tar.gz` in the
`rev4a-backups` volume). This cannot be undone. Volume and backup removal are
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

The backup file lives in Docker volume `rev4a-backups`. Backups exclude the npm
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
   in `rev4a-backups`. **If the backup fails, the recreate is aborted** and the
   running container is left untouched.
2. The old container is removed (`docker rm -f`) and a new one is created with the
   same image tag, environment variables (`AGENT_*`, `MODEL_*`, `OPENCLAW_*`),
   labels, port mappings, and network — reattaching the same volume.
3. After startup, `applyRuntimeConfig()` (from `lib/agent-setup.ts`) guarantees:
   - `hooks.bootstrap-extra-files` (Rev4a system rules injection)
   - `skills.load.extraDirs` (shared skills discovery)
   - `models.providers.rev4a` (provider proxy, host-dependent)
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

### `POST /api/agents/[id]/lifecycle`
Start, stop or restart an agent container.

**Auth:** browser cookie or bearer token

**Body:** `{ "action": "start" | "stop" | "restart" }`

Redundant actions are no-ops: starting a running container, or stopping a stopped
one, succeeds without touching it.

**Errors:** `400` for a malformed body, an unknown action, or an invalid agent id;
`404` when no container carries that `AGENT_ID`.

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
    "agents": { "defaults": { "model": { "primary": "rev4a/deepseek/deepseek-flash", "fallbacks": [] } } },
    "models": { "providers": { "rev4a": { "baseUrl": "...", "apiKey": "***", "models": [...] } } }
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

**Auth:** browser cookie or bearer token

The ghcr.io digest lookup is cached for 10 minutes and de-duplicated while in
flight, so polling this endpoint does not re-query the registry every time.

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
| `needsUpdate` | `true` if local manifest digest differs from remote registry |
| `downloading` | Whether a download is currently running |
| `localId` | SHA256 ID of the local image, or null |

### `POST /api/agents/download-image`
Starts pulling or building the `openclaw-agent-base:latest` image. Returns 202
Accepted immediately — the operation runs in the background and writes logs.
The frontend polls `GET /api/agents/image-status` for progress updates.

**Auth:** browser cookie or bearer token

**Response (202):**
```json
{ "status": "downloading" }
```

**Error (409):**
```json
{ "error": "A download is already in progress" }
```

Image state is managed in `lib/buildAgentImage.ts` (library functions, not HTTP routes):
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
    "displayName": "Argus",
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
      "model": "deepseek/deepseek-flash",
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
    { "id": "container-agent_8ba21f83", "label": "Giuanmuzzziins", "type": "container" }
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

## Provider keys and credentials

Provider API keys are read with `GET /api/gateway/provider` and set with
`POST /api/gateway/provider` — documented in `docs/dev/PROVIDERS.md`, which is the
only file carrying that endpoint's request bodies. `PUT` toggles a model, not a
key. The keys are stored in `data/provider-keys.json`.
Third-party service credentials are managed under `/api/credentials`
(documented below) and stored in `credentials.db`.

There is no `/api/vault` route, and no per-credential agent scoping: any stored
credential can be synced to any container.

Full key management documentation at [PROVIDERS.md](PROVIDERS.md).

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

The container list is the only container route. There is no logs endpoint and no
action endpoint: logs are read through the terminal WebSocket, and lifecycle
operations on agent containers go through `/api/agents/[id]/lifecycle`.

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

### Terminal WebSocket

Not an `/api/` route and not on the dashboard port. `terminal-ws-server.js`
listens on **`ws://127.0.0.1:3741`** (`TERMINAL_WS_PORT`), bound to the loopback
interface only, and speaks the PTY protocol described in
[CONTAINER-TERMINAL.md](../CONTAINER-TERMINAL.md).

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
- **Shared:** skills in `~/.config/rev4a/shared/shared-skills` on the VPS host (global, available to all agents)
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
      "path": "~/.config/rev4a/shared/shared-skills/code-review",
      "skillMdPath": "~/.config/rev4a/shared/shared-skills/code-review/SKILL.md",
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
  "destPath": "~/.config/rev4a/shared/shared-skills/my-custom-skill",
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

## Assistant (PULSE)

### `POST /api/assistant`
Chat with the built-in AI assistant (PULSE).

**Auth:** browser cookie

**Body:**
```json
{
  "message": "What can I do on the Agents page?",
  "page": "/agents",
  "model": "deepseek/deepseek-flash",
  "history": []
}
```

| Field     | Type                    | Required | Description                                      |
|-----------|-------------------------|----------|--------------------------------------------------|
| `message` | string                  | yes      | The user's question                              |
| `page`    | string                  | no       | Current page path (used for contextual prompts)  |
| `model`   | string                  | no       | AI model to use (e.g. `deepseek/deepseek-flash`) |
| `history` | `{role, content}[]`     | no       | Recent conversation history (up to 10 messages)  |

**Response:** `text/event-stream` (Server-Sent Events)

PULSE streams the assistant response as SSE chunks. Each chunk follows the
[OpenAI streaming format](https://platform.openai.com/docs/api-reference/chat/streaming):
```text
data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}

data: {"choices":[{"delta":{"content":"! How can"},"index":0}]}

data: [DONE]
```

**Errors:** JSON `{ "error": "..." }` with the appropriate HTTP status code.

**Notes:**
- PULSE routes the request **directly to the upstream provider** (not via the local Provider Gateway), using the API key from `data/provider-keys.json`.
- The system prompt is built dynamically based on `PAGE_CONTEXT` (hardcoded in the route handler) — no database access.
- PULSE does **not** have access to live data; she only knows page descriptions and navigation links.

---

## Credentials

### `GET /api/credentials`
List all stored credential profiles and the provider registry.

**Auth:** browser cookie or bearer token

**Response:** `{ profiles: CredentialProfile[], providers: CredentialProviderDef[] }`

Secrets are never returned here — each profile carries only `secretMasked`.

Each entry in a provider's `fields` may carry `docsUrl` and `docsLabel`, pointing at the page where that specific value is created. The provider-level `docsUrl` is the general one shown on the card; the field-level pair is what the add/edit form renders next to the input it is asking you to fill.

### `POST /api/credentials`
Create a new credential profile.

**Auth:** browser cookie or bearer token

**Body:** `{ providerId: string, label: string, secret: Record<string, string> }`

**Response:** `{ id: string }` (201)

### `GET /api/credentials/[id]`
Get a single credential profile (no secret returned).

**Auth:** browser cookie or bearer token

### `PATCH /api/credentials/[id]`
Update label and/or secret of a credential.

**Auth:** browser cookie or bearer token

**Body:** `{ label: string, secret: Record<string, string> }`

Secret fields are **merged** onto the stored payload, not substituted for it:
only the fields carrying a non-empty value are written, and every blank field
keeps whatever is already stored. This matters for the one two-field provider,
Trello, where rotating the `token` alone must leave `apiKey` intact — both are
required by the REST delivery. An empty `secret` (every field blank) therefore
updates the label only.

When the merge changes the stored payload, `last_synced_at` is reset to `NULL`:
the agents still hold the previous value, so the profile reads "synced never"
until it is delivered again, and `GET /api/credentials/detect` reports those
agents as holding an unrecognised credential for that provider.

### `DELETE /api/credentials/[id]`
Delete a credential and its secret permanently.

**Auth:** browser cookie or bearer token

### `POST /api/credentials/[id]/sync`
Sync the credential to agent containers.

**Auth:** browser cookie or bearer token

**Body (optional):** `{ containers?: string[] }` — if omitted, targets every agent container carrying an `AGENT_ID` label.

**Response:** `{ results: { container: string, status: 'ok'|'error', error?: string }[] }`

Each **targeted** container is first cleaned of this provider only — other
providers on the same container are left alone — and then receives the new
credential and its TOOLS.md row.

**Containers outside `containers` are not touched.** Syncing is therefore not a
way to revoke: dropping an agent from the list leaves whatever it already holds
in place. Use `DELETE` below to remove a credential from a container.

### `DELETE /api/credentials/[id]/sync`
Remove this credential from a single container ("de-sync").

**Auth:** browser cookie or bearer token

**Body:** `{ container: string }` — required.

**Response:** `{ ok: true }`

Deletes the provider's CLI auth inside that container and drops its TOOLS.md
row. `last_synced_at` is deliberately left untouched — it records the last
delivery, and a removal is not one — and the audit entry is recorded as
`desync`. The profile stays `active`, because de-sync targets one container and
the credential may still be delivered to others.

### `GET /api/credentials/detect`
Live-detect which credentials are actually present inside agent containers.

**Auth:** browser cookie or bearer token

**Query params (optional):** `?agent=prometheus` — filter to a single container.

Costly: one `docker exec` per container, measured at ~6.5s each. Almost all of
that is the three CLI calls reaching the network from inside the container, so
the figure is largely platform-independent — the `docker exec` itself is ~90ms,
and the local file reads another ~100ms. Callers should treat it as a background
refresh, not something to block a page render on.

**Response:**
```json
{
  "agents": [
    {
      "container": "prometheus",
      "agentId": "prometheus",
      "displayName": "Prometheus",
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
      "notionLoggedIn": false,
      "toolsMdHasMarkers": true,
      "matchedProfiles": [
        { "profileId": "cred_xxx", "providerId": "github-pat", "label": "GitHub" }
      ],
      "installedProviders": ["github-pat"]
    }
  ]
}
```

An agent whose probe failed is returned in its place as
`{ "container", "agentId", "error" }` — none of the fields above are present, so
consumers must check `error` first.

Each container is read with a **single** `docker exec` running one script that
emits NUL-delimited key/value pairs; containers are probed concurrently. The
script reads the credential files directly and the parsing happens in
JavaScript. Three CLI calls run last and only feed display fields — `githubUser`,
`vercelUser`, `vercelTeam`, and the `githubLoggedIn` / `vercelLoggedIn` /
`supabaseLoggedIn` flags, along with `supabaseLinked` and `supabaseProjectRef`,
which are read only when `supabaseLoggedIn` is true. `supabaseLoggedIn` follows
the **exit status** of `supabase projects list`, not the text it prints, so a
failure whose wording is unfamiliar still reads as not logged in.
`trelloLoggedIn` and `notionLoggedIn` come from the config files instead, and so
survive a probe cut short. The three calls reach the network from inside the
container, so a completion sentinel is emitted before them: a probe cut short
during them still yields valid token matching, with those display fields empty.

Credential files read: `~/.config/gh/hosts.yml`,
`~/.local/share/com.vercel.cli/auth.json` and `config.json`,
`~/.supabase/access-token` and `/data/supabase/config.toml`,
`~/.config/trello/config.json`, `~/.config/notion/config.json`, plus TOOLS.md
markers at `/root/.openclaw/workspace/TOOLS.md`.

`matchedProfiles` is determined by SHA256-hashing the token installed in the container
and comparing it against the hashed token of each stored profile in the vault.
Only exact token matches produce a match — no heuristics, no broad profile-level guesses.

`installedProviders` lists every provider holding a token, matched or not. A
provider present there but absent from `matchedProfiles` holds a credential no
stored profile accounts for — an edited-but-not-resynced credential, one
installed by hand, or the remains of a deleted profile.

### `POST /api/credentials/[id]/reveal`
Return the raw secret payload. Every call is written to `credential_audit_log`, which no route or view reads.
Use sparingly.

**Auth:** browser cookie or bearer token

Secrets are stored **unencrypted** in `credentials.db` — `credential_secrets.payload`
holds the raw JSON. Anything that can read that file, or reach this endpoint with a
valid session, has the secrets in the clear.

**Response:** `{ secret: Record<string, string> }`

---

## Diagnostics

### `GET /api/debug`
Whether the three auth-related environment variables are set. Booleans only —
no value, masked or otherwise, is returned.

**Auth:** browser cookie or bearer token

**Response:** `{ "hasPassword": true, "hasJwtSecret": true, "hasToken": false }`

### `GET /api/envcheck`
The process environment, with `REV4A_PASSWORD`, `REV4A_TOKEN`,
`REV4A_JWT_SECRET` and `PROVIDER_DEEPSEEK_API_KEY` redacted. Every other
variable is returned **in the clear**, so treat the response as sensitive.

**Auth:** browser cookie or bearer token

### `GET /api/provider-usage`
Usage and quota state per provider, including live OpenRouter figures.

**Auth:** browser cookie or bearer token

**Response:** `{ "providers": [...], "openrouterLive": {…}, "quotas": {…} }`

### `GET /api/update-check`
Installed version against the latest published one.

**Auth:** browser cookie or bearer token

**Query params:** `check=1` queries the registry; without it the answer comes
from local state only.

**Response:** `{ "installed": "1.1.15", "latest": "1.1.16", "updateAvailable": true, "package": "@flame0510/project-aether" }`

### `POST /api/update-check`
Run `rev4a update` as a detached background process. The dashboard restarts
itself as part of the update, so the connection drops.

**Auth:** browser cookie or bearer token

### `GET /api/alerts/smoke`
Send a test alert, to verify the Telegram alerting path end to end.

**Auth:** browser cookie or bearer token

**Query params:** `stale=0` skips the staleness check.

**Response:** `{ "ok": true, "stale": true, "result": {…}, "dryRun": false }` —
`dryRun` is `true` when `REV4A_TELEGRAM_BOT_TOKEN` or `REV4A_TELEGRAM_CHAT_ID`
is unset, meaning nothing was actually sent.

**Errors:** `403` when smoke alerts are disabled.

---

## Error Format

All errors return JSON:
```json
{ "error": "description of what went wrong" }
```

Common status codes: `400` bad request, `401` unauthorized, `404` not found, `500` server error.
