# Provider Gateway & Key Management

> **Last updated:** 2026-07-31

This document covers the Rev4a Provider Gateway (proxy),
the vault key endpoint, and how agent containers authenticate against the
Rev4a proxy.

> **Note:** The old `/providers` UI page and its API routes (`/api/providers/*`,
> `/api/agent-providers`) have been removed (2026-07-27). Provider/API-key
> configuration is now centralized in the [Gateway](../GATEWAY.md) page.

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
     │ model: rev4a/deepseek-deepseek-v4-flash         │
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

Returns all enabled models from `models.config.json` at the project root in
OpenAI-compatible format.
Models are filtered by the `models.config.json` catalogue (tracked in the repo),
not by auto-discovery.

**Response:**
```json
{
  "object": "list",
  "total": 9,
  "data": [
    {
      "id": "deepseek/deepseek-v4-flash",
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
| Valid `rev4a` token | All enabled models |
| Invalid token | `total: 0`, empty `data` array |
| No token | `total: 0`, empty `data` array |

### Chat Completions

#### `POST /api/provider/v1/chat/completions` (optional)

Proxies a chat completion request to the correct upstream provider. The model
name is parsed to extract the provider and model ID.

**Model alias resolution:**

| Model alias | Upstream provider | Upstream model |
|---|---|---|
| `rev4a/deepseek-v4-flash` | `deepseek` | `deepseek-v4-flash` |
| `rev4a/deepseek-v4-pro` | `deepseek` | `deepseek-v4-pro` |
| `rev4a/kimi-k3` | `kimi` | `kimi-k3` |
| `rev4a/glm-5.2` | `glm` | `glm-5.2` |
| `rev4a/qwen3.7-plus` | `qwen` | `qwen3.7-plus` |

**Model parsing fallback:**
1. Check `request.provider` field
2. Check `MODEL_ALIASES` map (for `rev4a/` prefixed aliases)
3. Parse `provider/model` from the model string (e.g. `rev4a/kimi/kimi-k3` → provider `kimi`, model `kimi-k3`)
4. Fall back to `deepseek`

**Provider API paths:** Most providers use the standard `/v1/chat/completions` endpoint.
GLM uses `/api/paas/v4/chat/completions` and Qwen uses `/compatible-mode/v1/chat/completions`.
The upstream module (`app/api/provider/upstream.ts`) handles this via a per-provider `basePath` field.

**Request body** (OpenAI-compatible):
```json
{
  "model": "rev4a/deepseek-v4-flash",
  "messages": [{"role": "user", "content": "Hello"}]
}
```

The proxy authenticates using the provider's real API key from
`data/provider-keys.json`.

---

## Vault & Provider Key Endpoints

### `GET /api/vault/provider/key`

Returns the full API key for a provider. Used by the Providers page SHOW KEY flow.

**Query params:**

| Param | Required | Description |
|---|---|---|
| `provider` | Yes | Provider identifier (e.g. `openai`, `deepseek`) |
| `agent` | No | Docker container name for agent-targeted reads; omitting reads the VPS host |

**Auth:** browser cookie

**Response (200):**
```json
{
  "provider": "deepseek",
  "apiKey": "sk-...full-key...",
  "masked": "sk-...be03",
  "source": "local"
}
```

**Source values:**
- `local` — read from `data/provider-keys.json` on the VPS host
- `container` — read from inside the agent container config

**Error (404):** `{ "error": "not_found" }` — provider has no key

### `POST /api/vault/provider`

Add or update a stored provider credential in the vault.

**Body:** `{ "provider": "deepseek", "apiKey": "sk-...", "baseUrl": "https://api.deepseek.com" }`

**Response:** `{ "status": "ok", "provider": "deepseek", "masked": "sk-...be03", "updatedAt": 1749200000000 }`

### `DELETE /api/vault/provider`

Remove a stored provider credential from the vault.

**Body:** `{ "provider": "deepseek" }`

**Response:** `{ "status": "removed" }`

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
          { "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
          { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
        ]
      }
    }
  },
  "agents": {
    "defaults": {
      "model": {
        "primary": "rev4a/deepseek/deepseek-v4-flash"
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

- The `GET /api/vault/provider/key` endpoint is protected by the authentication
  middleware (browser cookie or bearer token). Only authenticated users can reveal
  keys.
- The UI **must never** log, screenshot, or otherwise persist the revealed key
  outside the active screen view.
- All secrets in documentation, logs, or reports must be masked (e.g. `sk-...ast4`).
- The Gateway's `GET /api/provider/v1/models` endpoint returns an empty list when
  no valid token is provided, preventing model information leakage.
- API keys live in `data/provider-keys.json` (gitignored), never in committed code.
