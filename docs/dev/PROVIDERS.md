# Provider Gateway & Key Management

> **Last updated:** 2026-11-27

This document covers the Rev4a Provider Gateway (proxy), the provider key
endpoints, and how agent containers authenticate against the Rev4a proxy.
Provider and API-key configuration lives in the [Gateway](GATEWAY.md) page.

---

## Rev4a Provider Gateway

The Rev4a server at `/api/provider/v1/` acts as an OpenAI-compatible proxy.
Agent containers point their `rev4a` provider to this gateway instead of
connecting directly to upstream APIs.

```
Agent Container          Rev4a Gateway              Upstream API
     │                         │                         │
     │ Authorization: Bearer <agent-proxy-token>               │
     │ POST /api/provider/v1/chat/completions            │
     │ model: rev4a/deepseek/deepseek-flash         │
     │────────────────────────>│                         │
     │                         │ POST https://api.deepseek.com/v1/chat/completions
     │                         │ Authorization: Bearer <deepseek-key>
     │                         │────────────────────────>│
     │                         │       response          │
     │                         │<────────────────────────│
     │       response          │                         │
     │<────────────────────────│                         │
```

### Authentication

The Gateway authenticates `Authorization` Bearer credentials using the shared
`rev4a` key in `<REV4A_DATA_DIR>/data/provider-keys.json` as the root for derived
agent tokens. The data directory defaults to `~/.config/rev4a` on Unix and to
`rev4a` under the roaming application data directory on Windows.

```json
{
  "rev4a": "<gateway-token>"
}
```

| Token match | Result |
|---|---|
| Valid derived agent token | Authenticated — identity comes from the token; caller header ignored |
| Matches `rev4a` key or `REV4A_API_KEY` | Authenticated — legacy identity from `x-rev4a-agent` |
| No match | `GET /models` returns empty list, `POST /chat/completions` returns 401 |
| No token | Same as no match |

Agent tokens are `r4a1.<agentId>.<mac>`, where `mac` is the canonical base64url
encoding of the full 32-byte HMAC-SHA256 with key = the shared `rev4a` key and
message = `"rev4a:agent-proxy:v1\0" + agentId` (the separator is a NUL byte).
Ids must match `AGENT_ID_RE` in `lib/proxy-usage.js`. The pure helpers in
`lib/agent-proxy-token.js` reject empty keys and invalid ids and verify in constant
time. No per-agent secret is stored on the server; rotating the shared key
invalidates every derived token. `REV4A_API_KEY` cannot derive agent credentials.

Only the 'rev4a' entry roots these tokens. Other provider keys in the file (e.g.
`deepseek`, `openrouter`) are ignored for authentication — they are used as
upstream credentials by the proxy, not as client tokens.

### Gateway key startup seeding

`rev4a serve` seeds the Gateway key before startup sync. A generated key is 48
lowercase hexadecimal characters. New and updated key files have mode `0600`
on POSIX.

- With no key file, startup creates it exclusively with `rev4a` and copies any
  configured `PROVIDER_DEEPSEEK_API_KEY` and `PROVIDER_OPENROUTER_API_KEY` values to
  `deepseek` and `openrouter`.
- With a readable, writable JSON object and no Gateway key, startup adds `rev4a`
  while preserving the other entries. It checks for concurrent changes before
  replacing the file. It keeps an existing non-empty Gateway key without logging
  a generation message.
- Startup leaves the file alone and warns when the file is unreadable, is invalid
  UTF-8 or invalid JSON, belongs to another user on POSIX or cannot be written.
  A dangling symlink also causes startup to skip seeding.
- Creating the file or adding the key logs `Gateway key generated (provider-keys.json)`.
  A concurrent edit that prevents seeding logs
  `Warning: provider-keys.json changed during startup; Gateway key not generated`.
- Use a literal path for `REV4A_DATA_DIR`. Startup warns and skips seeding if the
  path contains a variable reference such as `${PORT}` or the directory cannot be
  resolved.

To rotate the key, select **Generate** in Gateway and then **Save** to replace
the stored key and sync the fleet.

### Model Discovery

#### `GET /api/provider/v1/models`

Returns offered models from the local catalogue in OpenAI-compatible format:
enabled after user overrides, with a configured provider key. This endpoint never
fetches upstream models or sends upstream credentials.

**Response:**
```json
{
  "object": "list",
  "total": 9,
  "data": [
    {
      "id": "deepseek/deepseek-flash",
      "object": "model",
      "created": 1700000000,
      "owned_by": "deepseek"
    }
  ]
}
```

**Behaviour by auth state:**

| Auth state | Response |
|---|---|
| Valid agent token, shared `rev4a` key, or `REV4A_API_KEY` | All offered models |
| Invalid token | `total: 0`, empty `data` array |
| No token | `total: 0`, empty `data` array |

### Chat Completions

#### `POST /api/provider/v1/chat/completions` (optional)

Proxies a chat completion request to the correct upstream provider. The model
name is parsed to extract the provider and model ID.

**Model alias resolution:**

| Model alias | Upstream provider | Upstream model |
|---|---|---|
| `rev4a/deepseek-flash` | `deepseek` | `deepseek-flash` |
| `rev4a/deepseek-v4-pro` | `deepseek` | `deepseek-v4-pro` |

This map is a short list of two-segment shortcuts, not the general mechanism.
Every other model resolves through step 3 below, from its three-segment id:
`rev4a/kimi/kimi-k3` resolves to provider `kimi`, model `kimi-k3`. A two-segment
`rev4a/kimi-k3` is **not** an alias and does not resolve — `rev4a` is not a
provider key, so it falls through to the `deepseek` default with an unusable
model string.

**Model parsing fallback:**
1. Check `request.provider` field
2. Check `MODEL_ALIASES` map (for `rev4a/` prefixed aliases)
3. Parse `provider/model` from the model string (e.g. `rev4a/kimi/kimi-k3` → provider `kimi`, model `kimi-k3`)
4. Fall back to `deepseek`

**Metering.** The proxy is also the meter: after every upstream answer (2xx and errors, streaming
and not) it adds one call to `proxy_usage_hourly` in `costs.db` — hour, caller, provider, model, calls,
prompt / completion / cached tokens as the provider reports them, errors, and the cost at `priceAt()` for
the moment the call started (so DeepSeek's peak and off-peak bands are right). For an agent token,
the caller is the authenticated id in the token, regardless of `x-rev4a-agent`. It must also be a
known agent (`agent_id` or `container` in `agent_cost_sources`, cached for at most 60 s, never read
from Docker). This set retains historical agents: a deleted agent id still meters under its id
while its row remains, exactly like a legacy header naming that id. Deletion removes the
container holding the token; it does not revoke a copied token. Rotate the shared gateway key
to revoke all agent tokens, then sync to give running agents fresh tokens (Sync All also
rewrites stopped containers). An id outside the known set, or an unavailable set, meters as `unknown`;
a newly created agent can stay `unknown` until the daemon's cost pass and the cache refresh.
The sync still writes `models.providers.rev4a.headers` = `{ "x-rev4a-agent": "<AGENT_ID>" }` for older
Rev4a readers and upgrade tooling. This header is not forwarded upstream.
Only shared-key and `REV4A_API_KEY` callers use the header, with unchanged legacy rules: missing,
malformed or reserved (`assistant` / `unknown`, case-insensitive) values meter as `unknown`; known
ids always pass; other valid ids share a 200-distinct-ids-per-process-per-hour allowance. Token calls
do not use or consume that allowance. PULSE calls upstream directly and remains metered as `assistant`.
A streamed call carries its usage only in a last chunk that the client has to ask for, so for `stream: true`
the proxy sets `stream_options.include_usage` on the upstream request itself, to every upstream (a
provider that rejected the field would answer 400; DeepSeek and OpenAI accept it), and forwards that chunk (a
standard OpenAI chunk with an empty `choices`) with the rest of the stream: chunks pass through as they
arrive and are read on the fly, never collected. A client that disconnects mid-stream still records what
was seen (a call with no usage report counts in `no_usage`, and so does a stream cut by an upstream error after
a 200). Metering is best effort and runs after the response is handed over: a failure to write is logged and never
fails the proxied call. It is bounded, not free: `costs.db` is opened with a 200 ms busy timeout, so the worst case
of a locked database is about 200 ms once per minute while it stays locked (the wait is synchronous, so it blocks the
whole event loop), after which metering is skipped (calls dropped, one log line) for 60 s instead of trying on every call. See
`lib/proxy-usage.js` and `app/api/provider/upstream.ts`.

**Provider API paths.** The upstream module (`app/api/provider/upstream.ts`) defaults to
`/v1/chat/completions` after the configured base URL. GLM uses
`/api/paas/v4/chat/completions` and Qwen uses `/compatible-mode/v1/chat/completions`.
Google's base URL already includes `/v1beta/openai`, so its explicit empty `basePath`
appends only `/chat/completions`. This fixes requests that previously went to
`/v1beta/openai/v1/chat/completions`. [Google's Chat Completions compatibility guide](https://aistudio.google.com/docs/openai)

The Claude compatibility endpoint rejects `file` content parts. The direct Anthropic
catalogue advertises text and image input. [Anthropic's compatibility guide](https://platform.claude.com/docs/en/cli-sdks-libraries/libraries/openai-sdk)

**Request body** (OpenAI-compatible):
```json
{
  "model": "rev4a/deepseek-flash",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

The proxy authenticates using the provider's real API key from
`<REV4A_DATA_DIR>/data/provider-keys.json`.

Rev4a ignores an unreadable key file, logs one warning per unreadable file state
and leaves its content as is. Reads still tighten permissions on regular key files
to `0600` when needed. Saving or removing a key returns HTTP `409` until the file
is fixed or removed. The setup wizard displays the save error and stays on the
Providers step. Legacy environment keys are migrated only when the file is missing,
using exclusive creation. Saving also returns `409` if the final read fails,
the bytes differ or another writer creates the file first, though an edit can still
land between the comparison and the write.

Upstream request failures return `502` with the fixed message
`Gateway error: the upstream request failed` (`type: "gateway_error"`). Fetch error
messages can contain an authorization header: neither those messages nor error
objects, stacks or causes are returned or logged. Logs contain only the error
name and optional code. A stream that fails after headers were sent terminates
with the same fixed error text, without forwarding the raw stream exception.
Previously stored keys containing ASCII control characters
are refused before headers are built or any network request is sent; replace such
a key through the Gateway page. The existing vault is not rewritten by this check.

---

## Vault & Provider Key Endpoints

### `GET /api/gateway/provider`

Provider state and the model catalogue.

**Query params:**

| Param | Required | Description |
|---|---|---|
| `summary` | No | `1` returns only which providers have a key — no models, no pricing. The full response waits on live pricing from OpenRouter, a network round trip costing seconds; callers that need just the boolean must not pay for it. |

**Auth:** browser cookie or bearer token

### `POST /api/gateway/provider`

Store a provider API key, or re-run the sync without changing keys.

**Body:** `{ "provider": "deepseek", "apiKey": "sk-..." }`, or `{ "_syncOnly": true }`
to push the current configuration to every agent container without touching any key.

**Response:** `{ "status": "ok", "provider": "...", "configured": true, "sync": { ... } }`.
The key is saved before the sync runs, so `status` reports the save and `sync`
reports whether every agent received it; its shape is documented under
`PUT /api/gateway/provider` in [API-REFERENCE.md](API-REFERENCE.md). With
`_syncOnly` the sync *is* the operation: a failed or partial sync returns `502` with
`status: "error"` and `error` set to the summary. Unknown provider names are
rejected with `400` and the list of known providers.

API keys containing any ASCII control character (`U+0000`–`U+001F` or `U+007F`)
are rejected with `400` before trimming, saving or syncing. Ordinary surrounding
spaces are still trimmed, and an empty or space-only value still removes the key.

**Auth:** browser cookie or bearer token

### `PUT /api/gateway/provider`

Enable or disable a single model in the catalogue.

**Body:** `{ "modelId": "deepseek/deepseek-flash", "enabled": true }` — both fields
required. Unknown `modelId` returns `404`.

**Response:** as for the key save — `status` for the toggle, `sync` for whether
the agents received it. If Docker cannot be reached the toggle is refused with `503` and
nothing is saved; a key save in the same situation is saved and the failure reported.

**Auth:** browser cookie or bearer token

There is no `DELETE`: a provider key is cleared by storing an empty one.


---

## Agent Container Gateway Config

Inside each agent container, the `openclaw.json` file has this structure for the Rev4a provider:

```json
{
  "models": {
    "providers": {
      "rev4a": {
        "baseUrl": "http://host.docker.internal:3740/api/provider/v1",
        "api": "openai-completions",
        "apiKey": "r4a1.<agentId>.<mac>",
        "headers": { "x-rev4a-agent": "<agentId>" },
        "models": [
          { "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash" },
          { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "rev4a/deepseek/deepseek-flash"
      }
    }
  }
}
```

Key points:

- `models.providers.rev4a.models` uses model IDs **without** the `rev4a/` prefix
- `agents.defaults.model.primary` uses the model ID **with** the `rev4a/` 
  prefix (as it would appear at runtime). No fallbacks are set by default.
- The `apiKey` is derived for that agent id from the shared `rev4a` key. A generic
  block built without an agent id keeps the shared key and no header.

### SEC-20 update and rollback notes

Existing shared-key agents continue to work through the legacy path until sync or
patch replaces their provider block. Startup Sync All rewrites both running and
stopped containers (`docker ps -a`), except agents skipped for an active operation
or backup, or whose config cannot be read/written; its outcome is logged. Those
missed keep working with the shared key until a later successful sync or patch.
The rewrite is idempotent and uses the existing bounded per-container operations;
there is no table scan, schema migration, new dependency, or change to `.env` or
`<REV4A_DATA_DIR>/data/provider-keys.json`. Older OpenClaw agents receive the same provider shape and
version-specific model fields; only the opaque API credential changes.

Rollback to the previous release (`v1.24.0`, verified in local tagged code)
self-heals on a successful startup sync: `instrumentation.ts` calls
`syncAllAgents()`, which replaces the whole block, including `apiKey`, with the
shared key. That release also includes stopped containers, so they are rewritten
on that sync too. Skipped/failed agents need a later successful sync or provider
patch; a plain container start does not itself patch this block. Until rewritten,
the previous proxy rejects a derived token. No stored data needs restoring.
Backups contain the derived credential: restoring under the same id and unchanged
shared key keeps it valid; after a rotation it needs a fresh sync/patch. The upgrade
skill's `neutralize-backup.mjs` already removes the provider `apiKey` and identity header.

---

## Security Notes

- The `GET /api/gateway/provider` endpoint calls `requireAuthJWT` directly
  (browser cookie or bearer token) — API routes are never covered by `proxy.ts`
  (it explicitly exempts `/api/*`), so each route must guard itself. Only
  authenticated users can reveal keys.
- The UI **must never** log, screenshot, or otherwise persist the revealed key
  outside the active screen view.
- All secrets in documentation, logs, or reports must be masked (e.g. `sk-...ast4`).
- The Gateway's `GET /api/provider/v1/models` endpoint returns an empty list when
  no valid token is provided, preventing model information leakage.
- API keys live in `<REV4A_DATA_DIR>/data/provider-keys.json` (gitignored), never in committed code.
