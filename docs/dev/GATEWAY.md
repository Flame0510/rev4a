# Gateway Page

> **Last updated:** 2026-11-14

The Gateway page (`/gateway`) is the control panel for provider configuration:
API keys and the model catalogue offered to every agent container. It does not
assign models to agents.

The Gateway aggregates multiple upstream AI providers (DeepSeek, OpenAI, Anthropic,
Kimi, GLM, Qwen, and others) behind a single Rev4a provider. Agent containers see
only `rev4a` as their provider and route all LLM traffic through the Rev4a proxy
at `/api/provider/v1/`.

---

## Overview

```
Gateway Page  → Manage provider API keys, enable/disable models, push sync
Agent detail  → Change the primary model and fallbacks of one agent
```

The Gateway page is system configuration: which providers are wired up and which
models the fleet is offered. Assigning a model to one agent is that agent's
configuration, so it lives in the agent's detail panel (`app/agents/ModelSection.tsx`)
and not here.

The Gateway talks to each agent container directly via `docker exec`, reading and
writing to `/root/.openclaw/openclaw.json` inside the container.

---

## Providers

Lists all AI providers from `models.config.json` in the project root. Each provider
row shows:

- Provider name and label
- Configured API key (masked)
- Enable/disable toggles per model
- ADD / CHANGE / REMOVE KEY buttons

### Provider Key Storage

> **Where these files actually live.** Both sit under the Rev4a data directory,
> `REV4A_DATA`, which defaults to `~/.config/rev4a/` and moves with
> `REV4A_DATA_DIR`. Neither is in the repository. They are nested differently and
> this catches people out, including while writing this document:
>
> | file | full path |
> |---|---|
> | provider keys | `REV4A_DATA/data/provider-keys.json` |
> | model overrides | `REV4A_DATA/model-overrides.json` |
>
> Paths written below as `data/provider-keys.json` mean the first row.

Provider API keys are stored in `data/provider-keys.json`:

```json
{
  "deepseek": "sk-...",
  "openrouter": "sk-...",
  "rev4a": "<gateway key>"
}
```

The `rev4a` entry is the shared root key. Agent containers authenticate with their
own HMAC-derived proxy token; unsynced legacy clients may still use the shared key. See [`PROVIDERS.md`](PROVIDERS.md).

### Sync Flow

At startup, a missing gateway key is not a warning when Docker confirms there are no agent containers (`No agent containers to sync.`); existing containers or an unreachable Docker daemon retain the missing-key error, and the catalogue-unavailable check is unchanged.

When a provider key is saved, a model toggle is changed, Sync All is pressed, Rev4a
starts, or a time-of-day price changes (see [Costs](#costs-openclaw-prices-every-call)),
the Gateway:

1. **Reads** `models.config.json` and the overrides, and keeps the models that are
   enabled and whose provider has a key. If the file cannot be read and no earlier
   read succeeded, the sync stops here and reports `configError`
2. **Builds** a `models.providers.rev4a` config block (without `rev4a/` prefix on
   model IDs), each model carrying the `cost` in force now
3. **Lists** every container with the `AGENT_ID` Docker label, **running or
   not**. Stopped agents are included so that starting one later does not bring
   back an old catalogue
4. **Reads** each container's `/root/.openclaw/openclaw.json` — through
   `docker exec` when running, through `docker cp` otherwise (stopped, paused, created), since `exec`
   cannot reach them. A read that fails, or returns an empty object, stops
   there: **nothing is written** and the container is reported in `sync.failed`
5. **Cleans up** stale `models.json` and `auth-profiles.json` — running containers
   only, since it needs `exec`
6. **Writes** the file back with only `models.providers.rev4a` replaced — **does NOT
   touch** `agents.defaults.model` or `agents.list[].model`. Running containers get
   it through `docker exec` and hot-apply it; the others through `docker cp`, with
   the file's original mode, and apply it when started or resumed
7. **Does NOT restart** the gateway

Steps 4–6 for one container run inside that agent's `openclaw.json` write queue
(`lib/agent-config-lock.ts`), as does `patchRev4aProvider`: a credential, subscription, Telegram or
model write to the same agent waits its turn instead of racing the sync and losing an update.

### Agent proxy identity (proxy metering)

`buildRev4aProviderConfig(version, agentId)` writes `apiKey: r4a1.<agentId>.<mac>`,
derived from the shared key without a per-agent server-side store. The proxy
meters the authenticated token id after known-agent resolution; the header cannot
override it. Ids outside the known set meter as `unknown`. The known set is the
historical `agent_cost_sources` table, not a live-container list: a deleted id
retained there still receives attribution, just like a legacy header naming it.
The token lives in the container removed on deletion; deletion does not revoke a
copied token. Without an agent id, the generic block keeps the shared key. Rotate
the root to revoke every agent token; the next sync supplies fresh tokens to
running agents (and stopped containers too). Shared-key and `REV4A_API_KEY` callers
retain legacy header metering.

The `rev4a` block also carries `headers: { "x-rev4a-agent": "<AGENT_ID of that container>" }`
(`buildRev4aProviderConfig(version, agentId)`; one value per container, from the AGENT_ID label, the
container name when it has none; `patchRev4aProvider` reads the same label, so every path writes the same id).
OpenClaw sends it for compatibility with older Rev4a readers and the upgrade skill.
Startup sync, Sync All and per-agent patch (create, update, edit, recreate) write both
token and header. Sync All already includes stopped containers too; agents skipped
or missed keep their old shared key and continue on the legacy path until synced.
See [PROVIDERS.md](PROVIDERS.md#sec-20-update-and-rollback-notes) for update, backup
and verified `v1.24.0` rollback behavior (successful startup sync restores shared
keys for running and stopped agents; skipped/failed agents need a later sync/patch).

### Costs: OpenClaw prices every call

Every model in the `rev4a` block carries a `cost` — `{ input, output, cacheRead,
cacheWrite }` in $ per 1M tokens, from `priceAt()` in `lib/model-pricing.ts`. That is the
field OpenClaw's own cost accounting reads first after an agent's `models.json`, so each
agent prices every call, session and day itself, with the cache split out, and shows it in
its own Control UI too. Rev4a computes no cost: the daemon reads OpenClaw's figures into
`costs.db` and the Costs page (`/costs`) shows them (see
[DATABASE.md](DATABASE.md#costs-database-costsdb)).

- **No price, no `cost`.** A model without an entry in `model-pricing.json` or with a
  dynamic router price (`-1`, OpenRouter Auto) gets none, and OpenClaw counts its calls
  as "missing cost" rather than $0. The Costs page lists them, by model.
- **Free models** (all-zero price) are written with $0.000001 per 1M tokens for every
  rate: OpenClaw treats an all-zero `cost` as no price and would count every call as
  unpriced. A billion tokens come to $0.001.
- **Unknown cache rate.** An entry without `cacheRead` falls back to the input rate
  (cached tokens priced as if the cache gave no discount); one without `cacheWrite` to
  1.25 × the input rate — vendors that bill cache writes apart charge more than input
  (Anthropic's five-minute cache: 1.25×), and the ones that report no cache writes never
  use it. These fallbacks avoid treating an unknown cache rate as free, but can differ
  from what a vendor bills. `refresh:pricing` writes published OpenRouter cache rates;
  the file currently has cache-read rates for 107 models and cache-write rates for 44 of
  184 entries. Direct vendors are filled by hand from their pricing page.
- **Time-of-day prices.** DeepSeek bills half its rates off-peak (peak 01:00–04:00 and
  06:00–10:00 UTC, Monday–Friday). `PRICE_SCHEDULES` in `lib/model-pricing.ts` holds
  that schedule; `priceAt()` writes the rate of the moment, and
  `lib/price-schedule-sync.ts` (started by `instrumentation.ts`) checks at most every
  minute — and exactly at a change due within the minute — whether the bands in force
  differ from the ones last written, and runs a full sync when they do; a sync that
  missed an agent is retried every 5 minutes, at most 3 times for one band — an agent busy
  with an update, recreate, restore or edit writes the prices itself when it finishes; the
  bands count as written after any sync, since a sync that misses one agent writes all the
  others — and a new change is written at once, whatever retry was pending. A check rather than one timer to the next
  change: a timer fires late after the machine sleeps, a check a minute after it wakes
  (simulated: asleep 01:05–05:00 UTC across the 04:00 change → synced at 05:00). OpenClaw keeps the cost it recorded at call
  time, so a later change of rate does not reprice a call (verified with a real call,
  priced off-peak and read again after the switch to peak). Chinese public holidays,
  which DeepSeek bills off-peak all day, are priced as peak — a small overestimate.
  Where the band is visible: the Costs page header (a pill with the time of the next
  change), the agent panel's COSTS section (Rates now), and the Gateway page — a
  band-priced model's row carries a PEAK / OFF-PEAK chip next to its price, and that price
  is the rate in force now (off-peak it shows half the list price), refreshed just after
  each change while the page stays open (`nextPriceChangeMs`).
- **Calls made before a model had a price** are priced by OpenClaw when read, at the
  rate in force then; OpenClaw reindexes its transcripts after a price change, which is
  why a read can briefly answer `cacheStatus: refreshing`.

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
          { "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash" },
          { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro" }
        ]
      }
    }
  }
}
```

OpenClaw automatically prefixes model IDs with the provider name at runtime,
producing `rev4a/deepseek/deepseek-flash`. The `mode` field is **not** set —
OpenClaw defaults to merging config models with auto-discovered models.

### Model Catalogue

The model catalogue lives in [`models.config.json`](../../models.config.json) at the project root.
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

Provider display names come from `lib/provider-labels.ts`: the Gateway's cards and the
details modal read the same map, so a provider is never called two things in one page.

### Model details (the details modal)

The Gateway model row has a **⋯ Details** button opening `ModelDetailsModal`
(`app/gateway/ModelDetailsModal.tsx`), fed by `GET /api/models/details?id=`. Three
sources, each one labelled in the modal:

| Source | File | Nature |
|---|---|---|
| Identity, enabled, modality, deprecation | `models.config.json` | curated by hand |
| Price | `model-pricing.json` | refreshed for `openrouter/*`, hand for direct vendors |
| Description, specs, benchmarks | `model-details.json` | **generated**, never hand-edited |

For a scheduled vendor, the modal labels the static rate as a list price; the Gateway
row shows the rate in force and its peak/off-peak band.

`npm run refresh:pricing` (script `scripts/refresh-model-pricing.mjs`) fetches the
OpenRouter catalogue once and writes both the prices and `model-details.json`:
description, release date (`created`), context and the provider's own limit, max output,
tokenizer, instruct type, knowledge cutoff, Hugging Face id, reasoning (mandatory, default
and supported efforts), supported parameters, and the benchmarks OpenRouter publishes
(design arenas with elo/rank/win-rate, Artificial Analysis indices).

**Size and architecture** come from a second source: for every entry with a
`hugging_face_id` the script asks the Hugging Face API (`safetensors.total` and the
per-dtype breakdown, the task, the languages, downloads and likes) **and the model's
`config.json`** — the API's summary config is reduced, the raw file is what carries the
architecture. That covers the **open-weight** models (DeepSeek, GLM, Kimi, Qwen, Llama,
StepFun…); a closed model has no card, so it gets no `params` and no `hf` block, and the
modal hides those rows rather than estimating. `--no-hf` skips the lookups.

Stored per model in an `hf` object: the architecture class and type, the mixture of
experts (`experts`, per token, shared), layers, hidden size, attention heads (and KV
heads, since MQA/GQA change what serving costs), vocabulary, the model's own max context,
whether it has a **vision encoder** (multimodal models nest their language model under
`text_config` and the encoder under `vision_config`), the precision (`fp8`,
`compressed-tensors`…) and the weight mix by dtype, the task, the languages and the
popularity. For a mixture-of-experts model the card's number is the **total**; an *active*
count is a derivation, so the modal shows the facts (experts, per token) and the curated
`info.params` free text can add the vendor's own "355B total, ~32B active". A direct entry is
matched through the vendor alias map (`glm` → `z-ai`, `kimi` → `moonshotai`) for the data
only — **its price stays the vendor's own**, and the modal says which is which.

Anything OpenRouter does not publish is curated in the catalogue as an optional `info`
block, and every number there carries its source:

```json
"info": {
  "params": "~1.8T MoE (active ~40B)",
  "docUrl": "https://docs.z.ai/guides/vlm/glm-5.3-flash",
  "knowledgeCutoff": "2026-03",
  "benchmarks": [ { "name": "SWE-bench Verified", "value": 78.4, "source": "https://…", "asOf": "2026-08-26" } ],
  "notes": "Native multimodal; 3x the coding-plan quota."
}
```

No generated field ever replaces a curated one silently: prices are separate files, and the
modal shows the generated part's date (`asOf`).

### Curating an `info` block

Nothing here is estimated, and every number carries its source and date. The workflow has
three steps, one command each:

```bash
npm run info:suggest -- <model id> …   # candidate facts from the model card (read-only)
# the maintainer, or a worker agent asked to follow the same contract, proposes the block
npm run info:verify  -- proposals.json   # the gate: refuses what the card does not support
```

- `scripts/model-info-suggest.mjs` prints the card's size sentences, its benchmark tables
  (headers included) and its doc links, so the reading is a lookup rather than a hunt.
- `scripts/model-info-verify.mjs` checks a proposal against the card: `evidence` present,
  every number in `params` in the card text, every benchmark value in a row named after it
  **under the column that names this model** (never a sibling variant), and `docUrl` when
  asked with `--check-links`. It exits non-zero on a rejected proposal.
- The proposal contract is what makes this safe: one JSON object per model with an
  `evidence` entry per field, the verbatim line, the column used and the card's own date.
  A worker that skips the evidence — or takes a value from a variant's column — is caught
  here, not in the catalogue. Benchmarks that a card states only for a sibling
  (`-Max`, `-Base`, `-HighSpeed`) are dropped.

---

## Per-agent model assignment

Lives in the agent detail panel, not on this page. `app/agents/ModelSection.tsx`
reads `GET /api/agents/[id]/model` for the current primary and fallbacks, and the
enabled catalogue from `GET /api/models`, which returns only models whose provider
has a configured API key in `<data dir>/provider-keys.json`. Note this page does
**not** apply that filter — `GET /api/gateway/provider` returns the whole catalogue
so you can add a key and enable its models in one pass. The filter is applied by
`/api/models` and by the sync.

Saving calls `PUT /api/gateway/agent`, which writes the container's
`openclaw.json`:

- `agents.defaults.model`, and the entry in `agents.list` whose `id` is `main` —
  found by id, not by position, and skipped entirely if no such entry exists. The
  primary is stored as `rev4a/<provider>/<model>`
- `fallbacks` omitted and `fallbacks: []` are different requests: omitted leaves the
  container's existing list untouched, `[]` clears it. The Model panel is the only
  UI that sets them; the create wizard does not
- **no restart** — `agents` is in OpenClaw's hot-reload column, so the write
  applies on the agent's next turn. Current OpenClaw reads the configuration per
  message; the Control UI picks the change up at once.

The agent list shows each agent's current model as a chip, fed by
`GET /api/agents/models-summary`. The red states are split by remedy, because they
look alike and need different actions:

- `NOT IN CATALOGUE` — the id is gone from the catalogue: pick another model;
- `NOT ENABLED` — it exists but is not offered, and the proxy refuses it: pick another model;
- `OUT OF SYNC` — the gateway offers the agent's primary, but this container's synced
  copy does not have it: run Sync All.

Amber `DEPRECATED` marks a working model on a retired name. All of these describe the
primary model; a neutral `NO FALLBACK` is the one chip about the fallback list, shown
when it is empty. Every agent gets them, stopped ones included (read from the volume
with `docker cp`). The agent's Model panel repeats the red and amber distinction in
its warning.

---

## Subscription models and proxy models

An agent's primary is either a **proxy model** (`rev4a/<provider>/<model>`, served by the Rev4a provider proxy from the catalogue on the Gateway page) or a **subscription model** (a bare `openai/<id>`, served by the ChatGPT (Codex) account the agent is signed in to, or a bare `anthropic/<id>`, served through Claude Code by the operator's Claude plan — Experimental; see the Subscriptions page and [ARCHITECTURE.md](../ARCHITECTURE.md)). A primary can therefore be a bare `openai/<id>` subscription model. The agents list shows it as "<id> · ChatGPT" (or "<id> · Claude") (some ids are also proxy models, which keep their plain name), with no chip of its own, and with the `NO FALLBACK` warning when it has no fallback (it goes silent at the usage limit). The `subscription:` mark of the save and its checks are in [API-REFERENCE.md](API-REFERENCE.md); a save with no `fallbacks` keeps stored bare `openai/<id>` refs unchanged. Subscription models are not in the catalogue and are not synced: the sync writes `models.providers.rev4a` only and never touches `agents.defaults.model`. The catalogue also has ids that start with `openai/` (reached through OpenRouter); those are stored as `rev4a/openai/<id>`, and the `rev4a/` prefix is what tells the two apart. `PUT /api/gateway/agent` takes `subscription:openai/<id>` or `subscription:anthropic/<id>` for the subscription kind (the Claude one only when the agent's Claude state is connected); the panel marks a bare `openai/<id>` only when `<id>` uses the characters `A-Za-z0-9._-`, and any other id (for example a legacy `openai/gpt-4o:free`) is saved as `rev4a/...` as before. The agent panel's MODEL section offers both kinds in every picker, the primary and each fallback, as groups: "Rev4a proxy" (the catalogue), "ChatGPT subscription" and "Claude subscription" (the models each account offers, shown only when the agent is connected to it). Any combination is allowed: a subscription primary with proxy fallbacks, a proxy primary with a subscription fallback, several of each. The Subscriptions page does not choose models.

**Safety net.** When the operator picks a subscription model as primary while the fallback list is empty, the panel pre-fills the previous primary as the first fallback before saving (with the note "Used when the ChatGPT subscription reaches its usage limit"); the operator can remove it. So an agent that uses a subscription model normally has its previous proxy model as `fallbacks[0]`: if the subscription's usage limit is reached, OpenClaw falls back to it by itself and the call goes through the proxy (and is metered there). Choosing a Rev4a model as primary in the agent panel replaces a subscription primary; that is an explicit choice, and the agent stays connected. Disconnecting on the Subscriptions page puts the agent back on its own model first.

## API Endpoints

### `PUT /api/gateway/provider`

Enables or disables a single model in the catalogue, then syncs every agent.
Only writes `models.providers.rev4a` — does NOT touch model references.

**Body:** `{ "modelId": "deepseek/deepseek-flash", "enabled": true }` — both
required. Missing either returns `400`; an unknown `modelId` returns `404`.
If Docker cannot be reached the toggle is refused with `503` and nothing is saved.

**Response:** `status` reports the toggle, saved before the sync runs; `sync`
reports whether every agent received it.
```json
{
  "status": "ok",
  "modelId": "deepseek/deepseek-flash",
  "enabled": false,
  "provider": "deepseek",
  "sync": { "ok": true, "activeModels": 2, "total": 2,
            "synced": ["agent_2a3c3a07", "agent_9253eee3"], "stopped": [], "failed": [],
            "summary": "Synced 2 of 2 agent(s)." }
}
```

Two failures, handled differently on purpose:

- **Docker unreachable** — refused before anything is written: `503`, nothing saved,
  the checkbox does not move, so the checkboxes never disagree with every agent.
- **An agent under a cold backup** is skipped: writing its config while tar reads the
  volume would put a half-changed file in the archive. It is listed in `sync.failed`
  with the reason; the next sync catches it up.
- **Some containers fail once Docker answers** — the toggle stands and `sync.failed`
  lists them; the page shows it in amber, and an agent whose primary is affected shows
  `OUT OF SYNC`. Rolling
  the override back would not restore consistency, because the containers that did
  receive the change would keep it.

Full shape in
[API-REFERENCE.md](API-REFERENCE.md).

### `PUT /api/gateway/agent`

Updates the primary model and fallbacks of a single agent container.

**Body:**
```json
{
  "containerName": "openclaw-atlas",
  "model": "deepseek/deepseek-flash",
  "fallbacks": ["deepseek/deepseek-v4-pro"]
}
```

Omit `fallbacks` to keep the container's current list; send `[]` to clear it.

**Response:** what was written, prefixed.
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

Full semantics in [API-REFERENCE.md](API-REFERENCE.md).

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
          "id": "deepseek/deepseek-flash",
          "name": "DeepSeek Flash",
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

   The model `input` list follows each agent's OpenClaw version
   (`lib/agent-versions.json`, resolved by `containerVersionSync()`): 2026.9.3 and 2026.9.9 accept
   `text | image | audio | video`, an older release may accept less, and one unknown
   value makes it discard the whole generated catalogue
   (`model catalog load issue`). That is why a version stays in the table while agents
   still run it.

5. **Entrypoint does not generate openclaw.json** — The entrypoint resolves the
   auth token and starts the gateway with `--allow-unconfigured`; OpenClaw
   generates its own default config on first boot. All post-creation config
   (controlUi, model refs, providers) is written by the create route
   (`POST /api/agents/create`) after the gateway is fully ready.
   Before the gateway starts, the entrypoint runs `openclaw doctor --fix --non-interactive`
   when the OpenClaw version changed since the last successful run (tracked in
   `/root/.openclaw/.last-version`), and fills in the image defaults that are missing:
   plugin load path, web search provider, heartbeat off. See
   [REV4A.md](../REV4A.md#agent-templates).

6. **Model ref written after gateway readiness** — When the wizard creates an agent,
   the create route waits for the gateway to finish starting (`waitForGatewayReady`), then writes
   `agents.defaults.model.primary` + fallbacks and the Control UI origin policy (`gateway.controlUi`),
   then writes the provider block from `buildRev4aProviderConfig()` with `openclaw config patch --stdin`.
   Nothing is restarted: the Gateway watches `openclaw.json` and reloads it by itself, and
   `gateway.controlUi` is hot-applied (`openclaw gateway restart` does nothing inside a
   container, so the route no longer runs it). The Gateway sync (`PUT /api/gateway/provider`)
   never touches model references — only `models.providers` is synced.

---

## Subscription runtimes (`anthropic/*` → Claude Code)

A Claude (Pro/Max) plan is used through **Claude Code** installed inside the agent, not through an
API key and not through the Rev4a proxy. OpenClaw only routes `anthropic/*` models to it when the
agent's configuration says so, and that rule is the one runtime key the subscription writes next to
the model refs:

```json
{ "agents": { "defaults": { "models": { "anthropic/*": { "agentRuntime": { "id": "claude-cli" } } } } } }
```

`POST /api/subscriptions/anthropic/login/code` writes it with `openclaw config patch --stdin` after
Claude Code reports a `claude.ai` sign-in, and reads it back before reporting connected. Disconnect
removes exactly that key: `{ "agents": { "defaults": { "models": { "anthropic/*": null } } } }`, or
`{ "agents": { "defaults": { "models": null } } }` when `anthropic/*` is the only key, so no empty
`"models": {}` is left behind. Other model keys are never touched. Rev4a does not use OpenClaw's
`models auth login --provider anthropic`: that method is offline-only and refused while the Gateway
runs.

The rule matters only for the bare subscription references: a `rev4a/anthropic/<id>` model goes
through the Rev4a proxy as before, exactly like `openai/<id>` vs `rev4a/openai/<id>`. Removing the
rule and reverting the model refs is what Disconnect does; the Claude Code binary itself stays in
`/root/.local/bin`, in the agent's data volume, so the next connect does not reinstall it.

---

## Maintaining the model catalogue

Two files, both tracked in the repo, both maintained by hand:

| File | Holds |
|---|---|
| `models.config.json` | the catalogue: id, name, provider, `enabled`, `modality`, deprecation flags |
| `model-pricing.json` | price per 1M tokens, keyed by the same ids |

They drift, because upstream catalogues change without telling anyone. Refresh
them on a schedule that suits you, and always before shipping a release.

### Where the truth lives

Do not copy figures from blog posts or search results — they go stale and
contradict each other. Two sources answer authoritatively:

```bash
# OpenRouter: ids, prices and input modalities for every model, no auth
curl -s https://openrouter.ai/api/v1/models

# DeepSeek: the definitive list of callable model names
curl -s https://api.deepseek.com/models -H "Authorization: Bearer $DEEPSEEK_KEY"
```

The OpenRouter payload carries `pricing.prompt`, `pricing.completion`,
`pricing.input_cache_read` (multiply by 1e6 for per-million figures) and
`architecture.input_modalities`, so prices and modalities can be checked in the
same pass.

For direct-provider prices, use the provider's own pricing page. DeepSeek's is
at `api-docs.deepseek.com/quick_start/pricing`. Record the **peak** rates, and
the cache-hit rate as `cacheRead` (`cacheWrite` is the input rate for a vendor that
bills a cache miss as ordinary input); the off-peak discount is applied by
`PRICE_SCHEDULES` in `lib/model-pricing.ts`, which is where a schedule change goes.
These prices are what every agent's OpenClaw computes its costs with (see
[Costs](#costs-openclaw-prices-every-call)).

### What to check, in order

1. **Models that no longer exist upstream.** Set `enabled: false`; do not delete
   an id an agent might still be configured with — see below.
2. **Prices that drifted.** Compare every `openrouter/*` entry against the live
   API; direct providers against their pricing page.
3. **Modalities.** `architecture.input_modalities` is authoritative. Compare the
   *set*, not the string: `text+image` and `image+text` are the same thing, and
   rewriting one into the other produces a diff full of noise.
4. **New models worth carrying.** Add with `enabled` reflecting policy, not
   availability — see the DeepSeek rule below.
5. **Retired names.** Mark them, do not remove them yet.

### The deprecation lifecycle

Upstream sometimes retires a model *name* while keeping it working, redirected to
a successor and billed at the successor's rates.

Handle it in two releases:

```json5
// release N — flag it. It still works, and it stays selectable.
{ "id": "provider/retired-model", "deprecated": true }

// release N+1 — remove it. Agents still on it show NOT IN CATALOGUE, in red.
```

The gap between the two releases is what gives anyone using it a chance to move.
Removing in one step turns a warning into an outage.

`deprecated` surfaces in two places: a `DEPRECATED` chip on the agent card, and a
`(deprecated)` tag on the option in the primary and fallback pickers of the
agent's Model panel. The tag rides on the option label, so a native select keeps
showing it once the model is chosen.

There is no field for the successor: the redirect is the provider's, and nothing here
acts on it. Where the successor matters, say so in prose.

Do **not** encode deprecation in `name`. The name is the model's name; the flag
renders itself, and putting it in both produces `DeepSeek V4 Flash (legacy →
Flash) (deprecated)`.

**Never remove an id in the same release you deprecate it**, and never remove one
without checking who uses it: an agent whose primary model leaves the catalogue
fails on its next turn, and with an empty fallback list it fails hard. The agent
cards surface this — `NOT IN CATALOGUE` in red — but only after the fact.

### Policy vs availability

`enabled` expresses **what this deployment should offer**, not what exists. Both
DeepSeek direct and OpenRouter carry the DeepSeek models; this deployment uses
the direct provider, so the OpenRouter copies ship disabled.

User toggles live separately in `<data dir>/model-overrides.json` and win over
`enabled`. When a default changes to match an existing override,
`toggleModelOverride` drops the now-redundant key on the next interaction, so the
overrides file stays limited to genuine divergence.

### After editing

- both files must stay valid JSON, and every `enabled` model needs a price entry
- remove pricing rows for ids you removed from the catalogue — orphans accumulate
- read the catalogue only through `lib/model-catalogue.ts`: `loadModelsConfig()` for
  the catalogue with overrides, `loadOfferedModels()` for what the deployment offers,
  `isModelOffered()` to decide whether to serve a request. Nothing else in the app
  reads `models.config.json`; `scripts/refresh-model-pricing.mjs` rewrites it offline,
  and the backup and restore scripts copy it
- if the file cannot be read, the last copy this process read successfully is used;
  with no earlier copy the sync refuses to push. Orphan overrides are pruned only
  when a toggle is saved against a freshly read catalogue

## Spend and loop alarms

The daemon evaluates four alarm rules after each costs pass from the proxy metering (`proxy_usage_hourly`), the vendor balance (`vendor_balance`) and the session copy (`agent_sessions`): a session near its model's context window, a failing retry loop, a day of spend out of proportion, and money leaving a USD provider account outside Rev4a. Alarms only. Rules, thresholds (`REV4A_SPEND_*`), snooze and delivery are in [REV4A.md](../REV4A.md#spend-and-loop-alarms). The proxy leaves a `proxy-metering-gap` marker next to `costs.db` when it pauses its metering (`markMeteringGap` in `lib/proxy-usage.js`), so a gap is never read as zero.

## Automation account adoption on OpenClaw 2026.10.10

Legacy LLM automations using stored inference accounts can report `Automation has no recorded
inference account.` after the evaluated 2026.9.3/2026.9.9 upgrade. The Update confirmation explains
this step; the Crons detail view recognizes that exact latest-run error and opens the native
automation settings. Command automations do not need an inference account.

Model inheritance and account authority are separate. A job can follow the agent model and its
configured fallbacks while retaining its selected account. A compatible fallback uses that account;
changing an interactive default does not authorize another account or billing route.

After a successful 9.x -> 2026.10.10 Update, Rev4a applies the owner-selected migration policy:
exactly one connected ChatGPT/Codex OAuth profile permits best-effort association of affected
cron jobs through native `cron.update` model/profile selection. A second native update restores
the previous model: Default jobs inherit the primary and fallbacks, and explicit models remain
explicit. Existing bindings and native-runtime jobs are skipped. The Agents result records counts
and failures. Before selecting the temporary model, Rev4a durably records the job's original model
(Default/NULL, empty or explicit), temporary pin and account reference in its own DB. An unfinished
record is reconciled before an already-bound job is treated as complete. Lost native responses
therefore remain repairable across passes and restarts; startup and 60-second background retries
restore recorded pins without adopting new jobs. Each repair re-reads the account/model and uses
a fresh `expectedConfigRevision`; operator changes are preserved. Only confirmed restoration marks
the journal finished. Journals are keyed by agent container, update ID and job ID; a rollback
followed by re-upgrade gets a new journal and adopts restored unbound jobs again. OpenClaw
10.10's `captureCronUpdatedInferenceBinding` does not create a new binding for CLI execution.
A lost-response pin on that route is reconciled from the exact journaled temporary model with
a fresh revision, even without a binding; a different bound account or operator model is preserved.
A changed connected-account count does not prevent a recorded pin repair.
Each new Update supersedes all unfinished earlier journals of that agent in the transaction that
claims the update. Adoption runs under that claim. Background repair considers only the latest
update's journal and takes an exclusive lifecycle claim; if another operation (including a cold
backup) owns the agent it skips the pass and retries later. Startup clears stale repair claims
without starting their containers. Superseded journals are never reconciled.
The Agents result counts **associated** only after the saved `inferenceBinding` is verified for
the intended account. Only a route established before mutation by OpenClaw's CLI-runtime resolver
reports **no binding needed (model left/restored)** without a binding and increments
`noBindingNeeded`, preserving Default or the original explicit model. An absent binding and an
unchanged model on other routes do not prove success: the journal remains pending and selection
is retried under a fresh revision. Rejected retries count as failed, never repaired.
No schedule, delivery account or enabled state changes. Zero/multiple accounts
remain unchanged. Read-only metadata checks use `job_json.inferenceBinding` because OpenClaw
removes that field from public cron responses. Mutations always use the supported RPC, with
`expectedConfigRevision`; Rev4a writes only its own journal, never the native OpenClaw DB. The 10.10 package evidence is
`docs/automation/cron-jobs/payloads.md` (Inference account continuity), `docs/cli/cron.md`
(`--clear-model`), `cron-lew_v2Zj.mjs` (account capture), and `job-mutations.worker-fr12aCYD.mjs`
(binding preservation when clearing the model).

When there are zero/multiple accounts or adoption failed:

1. Pause the automation in OpenClaw.
2. On Rev4a's Subscriptions page, find the intended account reference in that agent's connected row.
   Every ChatGPT OAuth profile is listed; choose deliberately when automatic single-account adoption did not apply.
3. In the native automation settings, choose Custom model, enter
   `<provider>/<model>@<profile-id>` with the intended model and account reference, then save.
4. To follow the agent model, choose Default and save again. To retain an explicit override,
   select its plain model again instead. Removing the temporary qualifier retains the account.
5. Verify a run, then resume only if the job was previously active.

The native delivery Account ID belongs to the channel. Inference adoption uses the model/account
reference above. If a save fails, keep the job paused and inspect the native error. A reported
failure to restore a temporary model override also needs review in the native settings.
