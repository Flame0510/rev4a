# Gateway Page

> **Last updated:** 2026-07-31

The Gateway page (`/gateway`) is the central control panel for managing provider
configurations and agent model assignments across all Docker containers.

The Gateway aggregates multiple upstream AI providers (DeepSeek, OpenAI, Anthropic,
Kimi, GLM, Qwen, and others) behind a single Rev4a provider. Agent containers see
only `rev4a` as their provider and route all LLM traffic through the Rev4a proxy
at `/api/provider/v1/`.

---

## Overview

```
Gateway Page
├── Provider Tab    → Manage provider API keys, enable/disable models, push sync
└── Agents Tab      → Change primary model per agent container
```

The Gateway talks to each agent container directly via `docker exec`, reading and
writing to `/root/.openclaw/openclaw.json` inside the container.

---

## Provider Tab

Lists all AI providers from `models.config.json` in the project root. Each provider
row shows:

- Provider name and label
- Configured API key (masked)
- Enable/disable toggles per model
- ADD / CHANGE / REMOVE KEY buttons

### Provider Key Storage

Provider API keys are stored in `data/provider-keys.json`:

```json
{
  "deepseek": "sk-...",
  "openrouter": "sk-...",
  "rev4a": "ciao"
}
```

The `rev4a` entry is the master gateway token. Agent containers authenticate
against the Rev4a provider proxy using this token. See [`PROVIDERS.md`](PROVIDERS.md).

### Sync Flow

When a provider key is saved or a model toggle is changed, the Gateway:

1. **Reads** `models.config.json` to get the full model catalogue
2. **Filters** enabled models for providers that have a configured API key
3. **Builds** a `models.providers.rev4a` config block (without `rev4a/` prefix
   on model IDs)
4. **Writes** the block into `/root/.openclaw/openclaw.json` on every agent container
   (containers with `AGENT_ID` Docker label)
5. **Cleans up** stale `models.json` and `auth-profiles.json` files inside each
   container
6. **Writes** the block into `/root/.openclaw/openclaw.json` on every agent container
   — **does NOT touch** `agents.defaults.model` or `agents.list[].model`
7. **Does NOT restart** the gateway — writes are live via file write

### Model ID Convention

Inside `models.providers.rev4a.models`, model IDs are stored **without** the
`rev4a/` prefix:

```json
{
  "models": {
    "providers": {
      "rev4a": {
        "baseUrl": "http://host.docker.internal:3740/api/provider/v1",
        "api": "openai-completions",
        "apiKey": "***",
        "models": [
          { "id": "deepseek/deepseek-v4-flash", "name": "DeepSeek V4 Flash" },
          { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
        ]
      }
    }
  }
}
```

OpenClaw automatically prefixes model IDs with the provider name at runtime,
producing `rev4a/deepseek/deepseek-v4-flash`. The `mode` field is **not** set —
OpenClaw defaults to merging config models with auto-discovered models.

### Model Catalogue

The model catalogue lives in [`models.config.json`](../models.config.json) at the project root.
This file is **tracked in the repository** and serves as the default model configuration
for anyone cloning the project. It defines all known models across all providers:

```json
{
  "models": [
    { "id": "openai/gpt-5.6-sol", "name": "GPT-5.6 Sol", "provider": "openai", "enabled": true },
    { "id": "openai/gpt-5.6-terra", "name": "GPT-5.6 Terra", "provider": "openai", "enabled": true },
    { "id": "openai/gpt-5.6-luna", "name": "GPT-5.6 Luna", "provider": "openai", "enabled": true },
    { "id": "openai/gpt-5.5", "name": "GPT-5.5", "provider": "openai", "enabled": true },
    { "id": "openai/gpt-5.4", "name": "GPT-5.4", "provider": "openai", "enabled": true },
    { "id": "openai/gpt-5.4-mini", "name": "GPT-5.4 Mini", "provider": "openai", "enabled": true },
    { "id": "anthropic/claude-fable-5", "name": "Claude Fable 5", "provider": "anthropic", "enabled": false },
    { "id": "anthropic/claude-opus-5", "name": "Claude Opus 5", "provider": "anthropic", "enabled": false },
    { "id": "anthropic/claude-sonnet-5", "name": "Claude Sonnet 5", "provider": "anthropic", "enabled": false },
    { "id": "groq/llama-3.3-70b-versatile", "name": "Llama 3.3 70B (Groq)", "provider": "groq", "enabled": false },
    { "id": "kimi/kimi-k3", "name": "Kimi K3", "provider": "kimi", "enabled": true },
    { "id": "glm/glm-5.2", "name": "GLM-5.2", "provider": "glm", "enabled": false },
    { "id": "qwen/qwen3.7-plus", "name": "Qwen 3.7 Plus", "provider": "qwen", "enabled": true }
  ]
}
```

Only enabled models for providers with a configured API key are synced to agent
containers.

---

## Agents Tab

Lists all agent containers discovered from Docker (containers with `AGENT_ID`
label). Each agent row shows:

- Agent name and container name
- Current primary model
- "Change Model" button

### Change Model Flow

Clicking "Change Model" opens an inline form with:

1. **Primary model select** — dropdown of all enabled models (filtered to
   configured providers only)

On save:

1. **PUT /api/gateway/agent** writes the model config to the container's
   `openclaw.json`:
   - `agents.defaults.model.primary` and `agents.list[0].model.primary` written
     with format `rev4a/<provider>/<model>`
   - No fallbacks are set unless explicitly provided
2. **No restart** — writes are live via `docker exec node -e`

### Model Select Filtering

The model select in the Agents tab only shows models whose provider has a
configured API key in `data/provider-keys.json`. This ensures users can only
select models that are actually available.

---

## API Endpoints

### `GET /api/gateway`

Returns live Gateway status from all agent containers. Reads agent model configs
via `openclaw models status --json` inside each container.

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
        "defaultModel": "rev4a/deepseek/deepseek-v4-flash",
        "configured": true
      }
    ]
  }
}
```

### `PUT /api/gateway/provider`

Triggers a full provider model sync to all agent containers. Only writes
`models.providers.rev4a` — does NOT touch model references.

**Body:** none (reads current provider state from `models.config.json` and
`data/provider-keys.json`)

**Response:**
```json
{
  "status": "ok",
  "activeModels": 2,
  "results": ["Active models: 2 across 1 agent(s)"]
}
```

### `PUT /api/gateway/agent`

Updates model config for a single agent container (primary model only).

**Body:**
```json
{
  "containerName": "openclaw-atlas",
  "model": "deepseek/deepseek-v4-flash"
}
```

**Response:**
```json
{
  "status": "ok",
  "agent": "openclaw-atlas",
  "model": {
    "primary": "rev4a/deepseek/deepseek-v4-flash"
  },
  "verify": { "ok": true, "bytes": 2058 }
}
```

### `GET /api/gateway/provider`

Returns current provider configuration state.

Add `?summary=1` for a cheap variant — `{ provider, label, configured }` only,
skipping the live-pricing fetch. Used by the agents page, which needs nothing
more than "is any provider configured" and shouldn't block on a network call to
OpenRouter to find out.

**Response:**
```json
{
  "providers": [
    {
      "provider": "deepseek",
      "label": "DeepSeek",
      "configured": true,
      "baseUrl": "https://api.deepseek.com",
      "models": [
        {
          "id": "deepseek/deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "enabled": true,
          "pricing": { "input": 0.05, "output": 0.10 },
          "pricingLive": true,
          "modality": "text->text"
        }
      ]
    }
  ]
}
```

`pricing` is USD per 1M tokens. `-1 / -1` means the model routes dynamically
(OpenRouter Auto) — the UI renders "Dynamic" and shows "varies" for
capabilities rather than concrete icons.

#### Live pricing

`model-pricing.json` is maintained by hand and drifts — 16 of 79 OpenRouter
entries were wrong when this was added, one understating the real cost ~8x.
`lib/openrouter-pricing.ts` overlays the live catalogue on top of it and sets
`pricingLive: true` on the models it covers, which the UI marks with a `LIVE`
pill.

- Endpoint: `GET https://openrouter.ai/api/v1/models` — public, no API key,
  CDN-cached, never billed.
- Scope: **only** models whose provider is `openrouter`. The same model sold
  direct (openai, anthropic, google…) has different rates, so applying
  OpenRouter's price there would show the wrong vendor's number.
- Cache mirrors what the endpoint itself declares: `max-age=300` for
  freshness, `stale-if-error=3600` as the upper bound past which a stale
  entry is dropped in favour of the static file. Failures back off for a
  minute instead of retrying on every request.
- Skipped entirely when OpenRouter isn't configured, so callers that only
  read `configured` (the agents page) don't wait on a network round trip.
- `modality` is **not** taken from upstream. `sync.ts` provisions agent
  containers from the curated `models.config.json` value, so a different
  capability set in the UI would advertise inputs the container never
  accepted. (`moonshotai/kimi-k3` currently differs: `text+image` curated
  vs `text+image+video` upstream.)

---

## Config Page (`/config`)

A companion page at `/config` that allows editing environment variables and
triggering a server restart.

### `PUT /api/config/env`

Update environment variables on the VPS host.

**Body:** `{ "REV4A_PASSWORD": "newpass", ... }`

**Response:** `{ "ok": true }`

### `POST /api/config/restart`

Restart the Rev4a server (via systemd).

**Response:** `{ "ok": true }`

---

## Key Design Decisions

1. **No `mode: 'replace'`** — The `mode` field is not written to the provider
   config. OpenClaw uses its default merge behavior, combining config models with
   auto-discovered models from the provider API.

2. **Model IDs without `rev4a/` prefix in config** — Inside
   `models.providers.rev4a.models`, model IDs do NOT include the `rev4a/`
   prefix. OpenClaw adds it automatically at runtime.

3. **Provider keys in `data/provider-keys.json`** — Not in env vars or
   committed code. This file is gitignored and managed exclusively through the
   Gateway UI.

4. **No gateway restart after model sync** — The sync module writes `models.providers`
   to the file directly without restarting the gateway.

5. **Entrypoint does not generate openclaw.json** — The entrypoint resolves the
   auth token and starts the gateway with `--allow-unconfigured`; OpenClaw
   generates its own default config on first boot. All post-creation config
   (controlUi, model refs, providers) is written by the create route
   (`POST /api/agents/create`) after the gateway is fully ready.
   The entrypoint also runs `openclaw doctor --non-interactive` **before** the
   gateway, but only when the OpenClaw version changed since last boot
   (tracked in `/root/.openclaw/.last-version`) — safe migrations only, no restart.

6. **Model ref written after gateway readiness** — When the wizard creates an agent,
   the create route waits for gateway health check, then writes
   `agents.defaults.model.primary` + fallbacks and `gateway.controlUi.allowedOrigins`,
   then calls `syncAgent(name)`. The Gateway sync (`PUT /api/gateway/provider`)
   never touches model references — only `models.providers` is synced.
