# Provider Gateway & Key Management

> **Last updated:** 2026-11-08

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
     │ Authorization: Bearer <rev4a-key>               │
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

The Gateway authenticates requests against `data/provider-keys.json`. The
`Authorization` Bearer token must match the value of the 'rev4a' entry:

```json
{
  "rev4a": "<gateway-token>"
}
```

| Token match | Result |
|---|---|
| Matches `rev4a` key | Authenticated — returns all enabled models or proxies the chat request |
| No match | `GET /models` returns empty list, `POST /chat/completions` returns 401 |
| No token | Same as no match |

Only the 'rev4a' entry is checked. Other provider keys in the file (e.g.
`deepseek`, `openrouter`) are ignored for authentication — they are used as
upstream credentials by the proxy, not as client tokens.

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
| Valid `rev4a` token | All offered models |
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
the moment the call started (so DeepSeek's peak and off-peak bands are right). All agents share one gateway
key, so the caller is named by the `x-rev4a-agent` header: the startup sync writes
`models.providers.rev4a.headers` = `{ "x-rev4a-agent": "<AGENT_ID>" }` into each agent (OpenClaw sends
these headers with every request to that provider). A request without a valid header is metered as
`unknown`; PULSE (`/api/assistant`) is metered as `assistant`. The header is not forwarded upstream.
The header is bounded, because anyone holding the gateway key can send any value: `assistant` and `unknown` in
it are not accepted (reserved, metered as `unknown`), and a valid id is always accepted when it is a known agent
(the `agent_id` or `container` values in `agent_cost_sources`, read at most every 60 s and never from Docker).
Any other valid id (an agent created since the daemon's last cost pass, at most five minutes ago, or every id when
that set cannot be read) is accepted up to 200 distinct ones per process per hour; beyond that the call is metered
as `unknown`.
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

**Provider API paths:** Most providers use the standard `/v1/chat/completions` endpoint.
GLM uses `/api/paas/v4/chat/completions` and Qwen uses `/compatible-mode/v1/chat/completions`.
The upstream module (`app/api/provider/upstream.ts`) handles this via a per-provider `basePath` field.

**Request body** (OpenAI-compatible):
```json
{
  "model": "rev4a/deepseek-flash",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

The proxy authenticates using the provider's real API key from
`data/provider-keys.json`.

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
        "apiKey": "<gateway-token>",
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
- The `apiKey` value must match the 'rev4a' entry in `data/provider-keys.json`
  for the container to successfully authenticate against the Gateway

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
- API keys live in `data/provider-keys.json` (gitignored), never in committed code.
