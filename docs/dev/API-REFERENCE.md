# Rev4a API Reference

> **Last updated:** 2026-10-06

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

### API-only auth
`Authorization: Bearer <REV4A_TOKEN>`. No other fallback is accepted: a `?token=` query
parameter is ignored (it would end up in logs and browser history).

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
Whether a supported OpenClaw version of the agent image is downloaded.

**Auth:** open before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Response:** `{ "exists": true, "version": "2026.9.3" }` (the newest one present), or
`{ "exists": false, "version": null }` when none is **or Docker is unreachable** — the two
are not distinguished.

### `POST /api/setup/agent-image`
Download the newest supported version the registry publishes, streaming progress as SSE
(`status`, `progress`, `step`, `log`, `complete`, `error`). Nothing is downloaded when
that version is already here as its pinned build (the same rules as
`POST /api/agents/download-image`).

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

**Response:** each provider carries its models, and a model carries `params` (the total
parameter count) when its Hugging Face card publishes one — the Gateway row shows it next
to the price, and a model without a card simply omits it. A model priced by time of day
carries `band` (`"peak"` or `"off-peak"`, what the vendor bills right now — the Gateway row
shows it as a chip) and its `pricing` is the rate in force at answer time, not the peak
list price: it flips with the band, like the agents' synced prices. The top level carries
`nextPriceChangeMs`, when the band flips next, so an open page can refresh the chips.

```json
{
  "nextPriceChangeMs": 1790532000000,
  "providers": [
    {
      "provider": "deepseek",
      "label": "DeepSeek",
      "configured": true,
      "baseUrl": "https://api.deepseek.com",
      "docsUrl": "https://platform.deepseek.com/api_keys",
      "models": [
        { "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash", "enabled": true, "band": "off-peak", "pricing": { "input": 0.15, "output": 0.6, "cacheRead": 0.003, "cacheWrite": 0.15 } },
        { "id": "deepseek/deepseek-v4-pro", "name": "DeepSeek V4 Pro", "enabled": true, "band": "off-peak", "pricing": { "input": 0.66, "output": 1.98, "cacheRead": 0.022, "cacheWrite": 0.66 } }
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

### `GET /api/models/details?id=<model id>`
Everything the details modal shows for one model, and nothing more: unknown optional
facts are omitted; `price` and `info` can be `null` when absent.

**Auth:** browser cookie or bearer token

**Response:**
```json
{
  "id": "glm/glm-5.3-flash", "name": "GLM-5.3 Flash", "provider": "glm",
  "modality": "text+image+video->text", "enabled": false, "deprecated": false,
  "price": { "input": 0.15, "output": 0.5, "source": "vendor", "scheduled": false },
  "details": { "description": "…", "created": "2026-08-26", "context": 1310720,
               "providerContext": 1048576, "maxOutput": 943718,
               "reasoning": { "mandatory": true, "default_effort": "max", "supported_efforts": ["max","high","low"] },
               "supportedParameters": ["tools","reasoning","…"],
               "benchmarks": { "design_arena": [ … ], "artificial_analysis": { … } },
               "huggingFaceId": "zai-org/GLM-5.3-Flash", "url": "https://openrouter.ai/…" },
  "info": null,
  "asOf": "2026-10-02T10:46:53.452Z",
  "detailsSource": "openrouter"
}
```

`price.source` is `openrouter` for an `openrouter/*` entry and `vendor` for a direct one,
which keeps prices honest: the refresh script never writes a vendor price. `price.scheduled`
identifies a time-of-day list price; the Gateway row separately shows the rate in force.
`details` comes
from the generated `model-details.json` (`npm run refresh:pricing`, see
`docs/dev/GATEWAY.md`), `info` from the catalogue's hand-written block, and `asOf` is when
the generated part was produced. An id the catalogue does not carry answers `404`.

**Errors:** `400` missing `id`, `404` unknown model.

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

**Errors:** `502` when the provider's API cannot be reached or rejects the call. For `glm`, Z.AI's token-quota endpoint only serves Coding Plan subscriptions: a pay-as-you-go key gets `502` with `reason: "no-balance-api"` — Z.AI exposes no balance API for such accounts (verified 2026-09-16), and the Gateway hides the badge on this reason instead of offering a retry.

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
    "cost_usd": 0,
    "status": "idle",
    "task_preview": "Run hygiene audit...",
    "started_at": 1749200000000,
    "ended_at": null,
    "updated_at": 1749201000000,
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

Agent costs come from `costs.db`: what each agent's own OpenClaw priced, copied by the
daemon (the queries are in `lib/agent-costs.ts` (spend) and `lib/cost-reconciliation.ts` (`vendor_balance`), on a read-only handle from `lib/costs-db.ts`). `GET /api/costs/usage` feeds the Costs
page, `GET /api/costs` the dashboard, `GET /api/costs/agent` the agent panel. `GET
/api/stats` and `GET /api/stats-since` still read the `sessions` table of `events.db`,
whose `cost_usd` is no longer estimated (always 0).

### `GET /api/costs/usage?range=today|7d|30d`
What the agents spent in a range of UTC days, today included (default `7d`), read from
`costs.db` (written by the daemon every 5 minutes, see `docs/dev/DATABASE.md`). Rev4a
computes no cost: every figure is the one OpenClaw recorded with the prices Rev4a syncs.

**Auth:** browser cookie or Bearer

**Response:**
```json
{
  "available": true,
  "range": "7d",
  "startDate": "2026-09-21",
  "endDate": "2026-09-27",
  "intervalS": 300,
  "pricing": { "vendor": "DeepSeek", "band": "off-peak", "nextChange": 1790557200000, "source": "https://api-docs.deepseek.com/quick_start/pricing" },
  "totals": { "cost": 0.0086, "tokens": 114053, "input": 47436, "output": 2233, "cacheRead": 64384, "cacheWrite": 0,
              "inputCost": 0.0071, "outputCost": 0.0013, "cacheReadCost": 0.0002, "cacheWriteCost": 0, "missing": 0 },
  "daily": [ { "date": "2026-09-21", "cost": 0.0071, "tokens": 96806, "missing": 0 } ],
  "byAgent": [ { "container": "agent_9253eee3", "agentId": "agent_9253eee3", "name": "test", "cost": 0.0077, "tokens": 96806,
                 "missing": 0, "collectedAt": 1790526404843, "attemptedAt": 1790526404843, "error": null } ],
  "byModel": [ { "provider": "rev4a", "model": "deepseek/deepseek-flash", "cost": 0.0086, "tokens": 114053, "calls": 13 } ],
  "sessions": [ { "container": "agent_9253eee3", "agentName": "test", "sessionId": "…", "sessionKey": "agent:main:…", "label": "…",
                  "agentId": "main", "model": "deepseek/deepseek-flash", "cost": 0.004, "tokens": 18681, "missing": 0, "lastActivity": 1790322536609 } ],
  "unpriced": [ { "model": "rev4a/deepseek/deepseek-v4-flash", "calls": 84, "agents": ["test", "test 2"] } ],
  "reconciliation": [ { "vendor": "deepseek", "currency": "USD", "from": 1790529518869, "to": 1790536317000,
                        "billed": 0.02, "priced": 0.0171, "topUps": 0, "readings": 3, "comparable": true } ],
  "proxy": {
    "available": true,
    "recordedCost": 0.62, "meteredCost": 6.81, "combinedCost": 6.81,
    "byAgent": [ { "key": "agent_9253eee3", "container": "agent_9253eee3", "agentId": "agent_9253eee3", "name": "test",
                   "recorded": 0.62, "recordedTokens": 4100000, "combined": 6.81, "gap": 6.19, "flagged": true,
                   "metered": { "agent": "agent_9253eee3", "calls": 1417, "promptTokens": 91000000, "completionTokens": 310000,
                                "cachedTokens": 80000000, "errors": 12, "noUsage": 0, "cost": 6.81 } } ]
  }
}
```

- `daily` has one entry per day of the range, zeros included.
- `missing` counts calls OpenClaw could not price (no price for their model): they are in
  the tokens, not in the cost. `unpriced` lists them by model over each agent's last 30
  days.
- `byAgent` holds every agent read, running or not, with use in the range, an error, or
  a read in the last 15 minutes; `error` is why its last read stored nothing (OpenClaw's
  own reason, e.g. "Gateway not reachable…"). An agent still being read (`attemptedAt`
  within 3 × `intervalS`) with an `error` or a `collectedAt` older than that is not
  current; a stopped or deleted agent is no longer read and keeps its last figures.
- `sessions`: the 20 most expensive sessions active in the range; a session's figures are
  its total over the last 30 days.
- `pricing`: the band DeepSeek bills at now and when it changes, when a DeepSeek model is
  on offer; `null` otherwise.
- `reconciliation`: per vendor with a configured key (DeepSeek, OpenRouter), what it
  billed next to what the agents priced over the same hourly readings — `{ vendor,
  currency, from, to, billed, priced, topUps, readings, comparable }`. `billed` is the
  balance drop (DeepSeek; rises are `topUps`, not spend) or the usage growth (OpenRouter);
  `priced` the growth of the agents' total for that vendor's models. `billed`/`priced`
  are `null` until two readings exist; `comparable` is false for a non-USD balance.
  `vendor` is the lowercase key (`deepseek`, `openrouter`); `pricing.vendor` is a display
  name. Known gaps, shown rather than corrected: the same key may also pay for the
  assistant or clients outside Rev4a; a top-up and spend in the same hour net out; an
  agent missed by a pass joins the agents' total one pass later; calls never priced are
  priced by OpenClaw when read, so the agents' total can grow for calls made earlier.
- `proxy`: what the Rev4a provider proxy metered over the same UTC days (`proxy_usage_hourly`, written
  by the proxy for every call it carries, with the provider's own token counts and `priceAt()` at the time
  of the call), next to each agent's recorded figure. `byAgent` pairs them by AGENT_ID (the
  `x-rev4a-agent` header the startup sync writes into each agent): `recorded` is OpenClaw's, `metered`
  the proxy's (`null` when nothing went through the proxy), `combined` the larger of the two, `gap` the
  proxy's excess (0 if none), `flagged` true when the proxy saw more than 20 % and more than 0.10 USD above
  the agent (never true for `unknown` and `assistant`, which have no recorded figure). Proxy rows
  under both an agent's AGENT_ID and its container name are merged into that agent before `combined` is computed. Agents left out of `byAgent` (stopped, nothing recorded in the range) are still paired by name, with a recorded figure of 0. Callers no known agent claims are listed on their own with `container`/`name` null:
  `agent: "unknown"` (a request without the header, e.g. an agent not yet synced or another client) and
  `agent: "assistant"` (PULSE). `recordedCost`, `meteredCost` and `combinedCost` are sums over those
  lines; `combinedCost` is the spend the page counts. `available: false` (no lines) when `costs.db`
  has no `proxy_usage_hourly` yet; `totals`, `daily` and the other lists are unchanged and stay the
  agents' own figures.
- `available: false` (zeros, empty lists) until the daemon has created `costs.db`.

**Errors:** `400` for another `range`; `500` when `costs.db` cannot be read.

---

### `GET /api/stats`
Current-month aggregate stats (tokens + cost) grouped by model, from the `sessions` table
(`started_at` is in milliseconds). The costs are the `sessions.cost_usd` column, which is no
longer estimated: 0, except rows written before 2026-09-27. Agent spend is `GET /api/costs/usage`.

**Auth:** Bearer or browser cookie

**Response:**
```json
{
  "total": {
    "total": 0,
    "total_in": 850000,
    "total_out": 210000,
    "sessions": 47
  },
  "byModel": [
    { "model": "rev4a/deepseek/deepseek-flash", "cost": 0, "tokens_in": 600000, "tokens_out": 150000, "sessions": 30 }
  ]
}
```

---

### `GET /api/stats-since?ts=<unix_ms>`
Sum of `sessions.cost_usd` since a given timestamp — 0 for sessions polled since 2026-09-27
(see `GET /api/stats`).

**Auth:** Bearer or browser cookie

**Query params:** `ts` — Unix timestamp in milliseconds

**Response:**
```json
{ "total": 0 }
```

---

### `GET /api/costs`
The dashboard's figures: today's spend (UTC day), all-time spend, today's calls without a
price, and today's spend by model — from `costs.db`. The SSE stream (`GET /api/stream`)
sends the same `today`.

**Auth:** browser cookie or Bearer

**Response:**
```json
{
  "today": 0.0112,
  "allTime": 0.0559,
  "allTimeSource": "agents_openclaw",
  "missingToday": 0,
  "byModel": [ { "model": "deepseek/deepseek-flash", "cost_usd": 0.0112, "tokens": 244157, "calls": 7 } ]
}
```

`byModel` lists the models that cost something today; the free and unpriced ones are on the
Costs page.

**Errors:** `500` when `costs.db` cannot be read.

---

### `GET /api/costs/agent?container=<name>`
One agent's spend for its panel, from `costs.db`.

**Auth:** browser cookie or Bearer

**Response:** `{ "available": true, "intervalS": 300, "pricing": { "vendor": "DeepSeek", "band": "off-peak", "nextChange": 1790532000000, "source": "https://api-docs.deepseek.com/quick_start/pricing" }, "today": 0.011, "week": 0.019,
"month": 0.022, "tokensMonth": 2409574, "topModel": { "model": "deepseek/deepseek-flash",
"cost": 0.022 }, "unpricedMonth": 81, "collectedAt": 1790529516737, "error": null }` —
UTC days (today, last 7, last 30); `pricing` is the band billed right now, the same object
the Costs page header shows (`null` when no scheduled model is on offer); `collectedAt`/`error`
from the agent's last read. Before `costs.db` exists, the response is
`{ "available": false, "intervalS": 300, "pricing": null }` (or the current pricing
object when a scheduled model is on offer).

**Errors:** `400` for an invalid container name; `500` when `costs.db` cannot be read.

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
Server-Sent Events stream. Every 5 s it sends one message per kind, each `{ type, data }`:
`events` (new rows of the `events` table, only when there are any), `sessions` (the 100 most
recent sessions with their lineage label) and `costs` (`{ "today": … }`, what the agents spent
today, UTC day — the same figure as `GET /api/costs`).

**Auth:** browser cookie or Bearer

**Event format:**
```
data: {"type":"sessions","data":[...]}
data: {"type":"costs","data":{"today":0.0112}}
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
    "image": "openclaw-agent-base:2026.9.3",
    "imageTag": "2026.9.3",
    "template": "prometheus",
    "status": "running",
    "state": "running",
    "ports": "",
    "ip": "172.19.0.5",
    "created": "2026-07-01T16:58:42.876829416Z",
    "env": ["AGENT_ID=prometheus", "AGENT_TEMPLATE=prometheus"],
    "controlPort": "3033",
    "openclawVersion": "2026.9.3",
    "updateAvailable": false,
    "newBuildAvailable": false
  }
]
```

**Notes:**
- `openclawVersion` comes from the image's `org.opencontainers.image.version` label (read by
  image id, so also for an image that lost every tag) or version tag, else from
  `openclaw --version` inside the running container (cached per image id); `null` for a
  stopped agent whose image carries neither.
- `updateAvailable` is `true` when a newer supported OpenClaw version is downloaded.
- `newBuildAvailable` is `true` when the image this release pins for the agent's version is
  downloaded and the agent's container runs a different image id (a recreate moves it).
- `controlPort` is the host port published for the Control UI. No link or token is
  returned: the Open buttons go through `GET /api/agents/[id]/open-control-ui`
- Containers are discovered via Docker API with label filter `AGENT_ID`
- Template is inferred from the container image name + agent ID directory match in `agent-templates/`

---

### `GET /api/agents/ports`
The host ports held by any container, running or stopped: the set the validators in
`lib/agent-ports.ts` take, sorted ascending. Backed by the shared lookup
(`getUsedHostPorts()`, `lib/agent-ports-server.ts`), which reads every container's
`HostConfig.PortBindings` — a stopped container keeps its block while `docker ps -a` and
the API's container list report nothing for it.

**Auth:** `rev4a_token` cookie or `Authorization: Bearer <REV4A_TOKEN>`

**Response:**
```json
{ "ports": [3700, 3701, 3710, 3711, 3741, 5555] }
```

The Edit panel fetches it when it opens and the create form refreshes it on mount (the
page also receives it as a prop), so both validate a range as the operator types, against
the same numbers and with the same messages, and both disable their action while the range
is refused.

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
| `name` | yes | Display name (`AGENT_NAME`); the container name and `AGENT_ID` are generated (`agent_<hex>`) |
| `template` | yes | Template name (directory in `agent-templates/`) |
| `portRange` | no | Optional port range (e.g. `3700-3709`) or single port (e.g. `3700`). Default: auto-assigned 10-port block, chosen by `findAvailablePortBlock()` |
| `model` | no | Primary model id. Must be offered by this deployment (in the catalogue, enabled, provider has a key), in any form the proxy accepts; otherwise `400`. Defaults to `rev4a/deepseek/deepseek-flash`, validated the same way |
| `fallbacks` | no | Array of fallback model IDs |

**Every agent is created with a host port mapping:**
- Port block: `-p <start>-<end>:3000-<3000+offset>` — maps a range of host ports to the same range starting at container port 3000
- Single port: `-p <port>:3000` — maps a single host port to container port 3000
- Control UI: the wizard's Open button goes through `GET /api/agents/[id]/open-control-ui`, like the Agents page
- Port 3740 is reserved for Rev4a
- A port held by any container, running or stopped, is refused (`400`): the shared lookup
  reads every container's bindings (`lib/agent-ports-server.ts`), because a stopped
  container keeps its allocation while `docker ps -a` and the API's list report none
- Image: `openclaw-agent-base:<version>`, the newest supported OpenClaw version downloaded here; `409` when none is

**Response:**
```json
{
  "success": true,
  "containerId": "00f5de1eb08d...",
  "containerName": "agent_2a3c3a07",
  "displayName": "my-agent",
  "image": "openclaw-agent-base:2026.9.3",
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

### `PATCH /api/agents/[id]`
Edit an agent's display name, its port range, or both. The job runs in the background
(`lib/agent-edit.ts`); this answers `202` once it has started. The container is rebuilt
on the current build of its OpenClaw version (a newer build if one was downloaded) — **without a backup**: the persistent volume is never
touched (`recreateAgentContainer()` in `lib/agent-recreate.ts`), then the gateway is
waited for (up to 5 minutes) and the runtime config re-applied.

The job is recorded in `agent_edits`, so a page reload or a Rev4a restart never loses it:
`GET` below reports the running or last edit, and while it runs anything else that would
touch the agent answers `409`.

**Auth:** browser cookie

**Body:**
```json
{ "displayName": "Argus", "portRange": "3700-3709" }
```

`portRange` is `"<start>"` or `"<start>-<end>"`, mapped onto the gateway port 3000
(`3700-3709` → `3700-3709:3000-3009`). It is validated with the same rules and messages as
agent creation (`lib/agent-ports.ts`) against the shared lookup
(`getUsedHostPorts()`, `lib/agent-ports-server.ts`): a range that holds Rev4a's port
`3740`, an invalid format, or a port already held by **another** container answers `400`
(`Ports already in use: 3711, 3712`) before anything is rebuilt. The agent's own published
ports are excluded, so keeping or shifting its block is not a conflict with itself.
A port held by a **stopped** container counts as in use: the lookup reads every
container's `HostConfig.PortBindings`, because both `docker ps -a --format '{{.Ports}}'`
and the API's container list report nothing for a container that is not running.
At least one field is required; an empty `displayName` is rejected.

The rebuild itself (`recreateAgentContainer()`) re-checks the ports it is about to
publish against every other container and refuses **before removing anything** when one
is taken, naming the holder: `Port 3700 is already published by agent_a0000004 (Night
Shift). Change this agent's port range in the Edit panel, then retry: nothing was
changed.` The row lands in `failed` with that message and the agent keeps running. The
same guard protects Update and Rollback, whose rows record the same text.

**Response (202):**
```json
{ "started": true, "id": 4 }
```

**Errors:** `400` invalid body, invalid port range or empty display name; `409` an edit,
recreate, restore, update or backup of this agent is already running.

---

### `GET /api/agents/[id]`
The running or last edit of an agent (`null` when it was never edited) — what the edit
banner polls to resume after a reload. `status`: `rebuilding` → `done` | `failed`;
`interrupted` after a Rev4a restart cut it off.

**Auth:** browser cookie or bearer token

```json
{
  "edit": {
    "id": 4, "agentId": "agent_2a3c3a07", "status": "rebuilding",
    "displayName": "test 2 async", "portRange": null,
    "error": null, "startedAtMs": 1790007512520, "finishedAtMs": null
  }
}
```

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

### `GET /api/agents/[id]/backup`
List the agent's backup archives in Docker volume `rev4a-backups`.

**Auth:** browser cookie or bearer token

**Response:**
```json
{ "backups": [ { "name": "agent-prometheus-2026-07-12_043512345.tar.gz", "size": "227.4 MB", "sizeBytes": 238442455, "date": "12/07/2026 04:35", "epoch": 1752292512 } ] }
```

Archives are created by the cold backup (`POST /api/agents/[id]/cold-backup`) and
excluded the npm package cache (`~/.npm/_cacache/`). Sorted most-recent-first.


---

### `DELETE /api/agents/[id]/backup?file=...`
Remove one backup archive from `rev4a-backups`.

**Auth:** browser cookie

**Response:** `{ "success": true }`

**Error (400):** invalid or path-traversing file name.

### `POST /api/agents/[id]/cold-backup`
Cold backup of the agent's volume (`lib/cold-backup.ts`). Returns `202` once the job
has started; the work continues in a helper container, `rev4a-backup-<id>`.

1. The agent is stopped (`docker stop -t 30`, kill as a fallback) if it runs.
2. The helper, started from the agent's own image, measures the volume (`du`),
   refuses when `rev4a-backups` has less free space than about 60% of it, and writes
   `agent-<id>-cold-<ts>.tar.gz.partial` (npm cache excluded) with GNU tar checkpoints
   for progress.
3. `tar -tzf` reads the whole archive back and must find `.openclaw/openclaw.json`;
   only then is it renamed to `.tar.gz`. A failed or cancelled job leaves no archive.
4. The agent is started again if it was running.

The job's state is the helper container and its labels, so it survives a Rev4a
restart: at startup, `reconcileColdBackups()` finishes helpers that exited and keeps
watching the rest.

While it runs, `POST restore`, `POST recreate`, `POST lifecycle`,
`PATCH` and `DELETE /api/agents/[id]` answer `409`, and the provider sync skips the
agent, reporting it in `sync.failed`.

**Auth:** browser cookie or bearer token

**Response (202):** `{ "started": true, "file": "agent-agent_9253eee3-cold-2026-09-16_000607123.tar.gz" }`

**Errors:** `404` no container or no volume; `409` a backup of this agent is already
running; `500` the helper could not start (the agent is started again if it was running).

### `GET /api/agents/[id]/cold-backup`
The running or last job; `{ "backup": null }` when there is none since Rev4a started.

```json
{
  "backup": {
    "agentId": "agent_9253eee3", "status": "running", "kind": "manual",
    "file": "agent-agent_9253eee3-cold-2026-09-16_000607123.tar.gz",
    "startedAtMs": 1789524367123, "finishedAtMs": null,
    "totalBytes": 2023456789, "doneBytes": 812400000, "percent": 40,
    "archiveBytes": null, "error": null
  }
}
```

`status` is `running`, `succeeded` or `failed`; `error` is `cancelled` for a cancelled job.

### `DELETE /api/agents/[id]/cold-backup`
Cancel the running job: the helper is removed, the partial archive deleted and the
agent started again if it was running. `409` when nothing is running.

---

### `POST /api/agents/[id]/restore?file=agent-prometheus-2026-07-12_043512345.tar.gz`
Restore an agent's persistent volume from a backup. The job runs in the background
(`lib/agent-restore.ts`); this answers `202` once it has started. No pre-restore backup is
taken: restoring replaces the volume with the archive on purpose.

1. The container is stopped if it runs.
2. The volume content is cleared and the archive extracted — up to 30 minutes, since a
   large workspace takes minutes to decompress. The file name reaches the container
   through its environment, never as shell syntax.
3. The container is started again even when the extract failed, so the agent never stays
   down. A volume with no container (volume-only agent) is restored anyway.

The job is recorded in `agent_restores`, so a page reload or a Rev4a restart never loses
it: while it runs, anything else that would touch the agent answers `409`
(`lib/agent-busy.ts`), and after a Rev4a restart an active row becomes `interrupted` with
the container started again.

**Auth:** browser cookie or bearer token

**Response (202):**
```json
{ "started": true, "id": 3 }
```

**Errors:** `400` invalid file name (not `agent-<id>-<safe charset>.tar.gz`); `404` the
archive does not exist; `409` a restore, recreate, update, edit or backup of this agent
is already running.

---

### `GET /api/agents/[id]/restore`
The running or last restore of an agent (`null` when it was never restored), with the
archive being applied. `status`: `restoring` → `done` | `failed`; `interrupted` after a
Rev4a restart cut it off.

**Auth:** browser cookie or bearer token

```json
{
  "restore": {
    "id": 3, "agentId": "agent_2a3c3a07", "status": "restoring",
    "file": "agent-agent_2a3c3a07-cold-2026-09-21_172032317.tar.gz",
    "error": null, "startedAtMs": 1790004046548, "finishedAtMs": null
  }
}
```

---

### `POST /api/agents/[id]/recreate`
Rebuild the agent container on its **own** OpenClaw version while preserving the
persistent volume (workspace files, credentials, state DB, config). A recreate never
changes version: moving to a newer OpenClaw version migrates the data one way, so it
is a separate update. The job runs in the background (`lib/agent-recreate.ts`); this
answers `202` once it has started.

The image is `openclaw-agent-base:<version>` for the version the agent runs
(`resolveRecreateImage()` in `lib/agent-images.ts`). When that tag is missing but the
container's image is still here, the image is tagged; when it is gone, a supported
version is pulled. An agent whose version cannot be read keeps its exact image id.

Flow (each step recorded in `agent_recreates`):
1. **Cold backup** `agent-<id>-prerecreate-<ts>.tar.gz` — the agent stops for it, so
   the archive cannot catch its SQLite files mid-write. **If the backup fails, the
   recreate aborts and the agent is started again.**
2. The container is rebuilt (`lib/agent-recreate.ts`) on the current build of its OpenClaw version (`openclaw-agent-base:<version>`, the pinned build when downloaded), environment
   variables (`AGENT_*`, `MODEL_*`, `OPENCLAW_*`), labels, port mappings and network,
   reattaching the same volume. The network comes from the attached networks, or from
   the container's `NetworkMode` when its endpoint was lost.
3. The gateway is waited for (`/startupz`, up to 5 minutes), then `applyRuntimeConfig()`
   (`lib/agent-setup.ts`) guarantees the hooks, shared skills, provider proxy and
   Control UI origin policy.
4. On success, older `prerecreate` archives are pruned to the newest two per agent
   (manual `cold` and `preupdate` archives are never touched).

A failure before the rebuild starts the old container again, so a failed recreate never
leaves the agent down. After a Rev4a restart, a job still active becomes `interrupted`
at startup and the agent is started again — but only once its backup helper has
finished, never while the archive is being written.

**Auth:** browser cookie or bearer token

**Response (202):**
```json
{ "started": true, "id": 12 }
```

**Errors:** `404` when no image can be resolved; `409` when there is no container, an
update, a recreate, a restore, an edit or a backup of this agent is running.

---

### `GET /api/agents/[id]/recreate`
The running or last recreate of an agent, with live backup progress (`null` when the
agent was never recreated).

**Auth:** browser cookie or bearer token

```json
{
  "recreate": {
    "id": 12, "agentId": "agent_9253eee3", "status": "backing_up",
    "image": "openclaw-agent-base:2026.9.3",
    "backupFile": "agent-agent_9253eee3-prerecreate-2026-09-17_171000.tar.gz",
    "backupPercent": 40, "error": null,
    "startedAtMs": 1789656372120, "finishedAtMs": null
  }
}
```

- `status`: `backing_up` → `recreating` → `done` | `failed`; `interrupted` after a
  Rev4a restart cut it off.
- `backupPercent` is live only while `backing_up`.

---

### `GET /api/agents/[id]/update`
The agent's OpenClaw version, the update it could take, and its latest update
(`lib/agent-update.ts`).

**Auth:** browser cookie or bearer token

```json
{
  "currentVersion": "2026.9.3",
  "candidate": { "fromVersion": "2026.9.3", "toVersion": "2026.9.4" },
  "update": {
    "id": 3, "agentId": "agent_9253eee3", "status": "backing_up",
    "fromVersion": "2026.9.3", "toVersion": "2026.9.4",
    "backupFile": "agent-agent_9253eee3-preupdate-2026.9.3-2026-09-16_003512345.tar.gz",
    "backupPercent": 40, "verification": null, "error": null,
    "startedAtMs": 1789524912000, "finishedAtMs": null
  }
}
```

- `candidate` is `null` when no newer supported version is downloaded.
- `update.status`: `pending` → `backing_up` → `migrating` → `verifying` → `done` |
  `failed`; `interrupted` after a Rev4a restart cut it off; `rolling_back` →
  `rolled_back` | `rollback_failed` for a rollback.
- `verification`: `{ sessions, lostEvents: [{ session, before, after }], missingCronJobs, ok }`.

`503` when Docker cannot be reached.

### `POST /api/agents/[id]/update`
Start an update. **Body (optional):** `{ "version": "2026.9.3" }`; by default the newest
supported version downloaded. Returns `202` with the new `update`; the steps continue in
the background.

1. **Preflight** (refused with `409`): the agent runs, the target is downloaded,
   supported and newer than the agent's version, no update or backup is running.
2. **Baseline**, inside the agent: transcript events per session (`transcript_events`
   rows in `openclaw-agent.sqlite`, plus `sessions/*.jsonl` and the
   `session-sqlite-import-archive/` the 9.x import moves old files into, taking the
   maximum per session; trajectory files not counted) and cron job names.
3. **`backing_up`**: cold backup `agent-<id>-preupdate-<from>-<ts>.tar.gz`
   (`startColdBackup`, agent left stopped).
4. **`migrating`**: the container is recreated on `openclaw-agent-base:<to>`
   (`lib/agent-recreate.ts`); its entrypoint runs `doctor --fix`; Rev4a waits up to 10
   minutes for `/startupz` to report `started` with the target version, then re-applies
   its config and provider block.
5. **`verifying`**: every session has at least as many events as before and every cron
   job is still there → `done`, then unused agent images are removed (`pruneAgentImages`).

A failure before the recreate starts the old container again. A failure after it leaves
the agent on the new version; the panel offers Rollback.

**Errors:** `400` unsupported version, `409` refused (reason in `error`), `500`.

While an update runs, `backup`, `cold-backup`, `restore`, `recreate`, `lifecycle`,
`PATCH` and `DELETE /api/agents/[id]` answer `409 "An update of this agent is running"`,
and the provider sync skips the agent.

### `POST /api/agents/[id]/update/rollback`
Roll back the latest update — `done`, `failed`, `interrupted` or `rollback_failed` — while
its pre-update backup exists. `202` with the `update` (`rolling_back`).

1. The previous version's image is made local (pulled when it is a supported version).
2. The agent is stopped and its volume replaced by the pre-update backup.
3. The container is recreated on `openclaw-agent-base:<from>` and must report that version.

Rev4a's config is not re-applied: the restored `openclaw.json` is the one that version
accepted. Everything the agent did after the backup is lost. `409` when there is nothing
to roll back, the backup is gone, or an update or backup is running.

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
- Clears the channel's approved senders in OpenClaw's pairing store (`clearChannelAllowlist()`)
- No restart required

---

### `GET /api/agents/[id]/channels/pairing?channel=telegram`
Get pending and approved pairings for a channel.

Pending requests come from `openclaw pairing list --channel <channel> --json`. Approved
senders come from OpenClaw's pairing store — on 2026.9.x the SQLite
`channel_pairing_allow_entries` rows in `~/.openclaw/state/openclaw.sqlite`, read through
the store's own `readChannelAllowFromStoreSync` (the credentials JSON files older
releases used are gone, and reading those returned nothing).

**Auth:** browser cookie

**Query params:**
| Param | Required | Description |
|---|---|---|
| `channel` | no | Channel name (default: `telegram`) |

**Response:** `{ pending: [...], approved: [...], error: null }` — `error` carries why the
approved list is empty when that is not simply "none" (the store could not be read); the
panel shows it instead of "No approved senders". A missing store is not an error.

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

There is no CLI or RPC for this (`openclaw pairing` covers pending requests only,
`channels.pairing.*` has no remove — verified on 2026.9.3). The pairing store's own
writer is used instead: `removeChannelAllowFromStoreEntry`, located by function name in
OpenClaw's `pairing-store` module and run inside the container, so the write goes
through the same state transaction the CLI uses. Rev4a supports 2026.9.x only, so no
older layout is handled. On a release that no longer exposes the writer the call
fails with a message pointing at `/allowlist remove` from the chat — nothing is silently
left unchanged.

**Auth:** browser cookie

**Query params:**
| Param | Required | Description |
|---|---|---|
| `channel` | no | Channel name (default: `telegram`) |
| `senderId` | yes | Sender ID to revoke |

**Response (200):** `{ "success": true }`

**Response (400):** `{ "error": "senderId query param is required" }`
**Response (404):** `{ "error": "..." }` when the store is unavailable
(the sender is already gone when present — the desired state).

---

### `GET /api/agents/[id]/devices`
Browser access to one agent's Control UI: requests waiting for approval and browsers
already approved.

**Auth:** browser cookie

Runs `openclaw devices list --json` inside the container with the async `dockerExec`;
see `lib/agent-devices.ts`. When the Gateway cannot be read `requiresApproval` is null
and both lists are empty.

**Response:**
```json
{
  "running": true,
  "requiresApproval": true,
  "pending": [
    {
      "requestId": "facd76cb-0dd5-462e-8d1d-d18ed35f6129",
      "deviceId": "f1ad26df8bc4…",
      "displayName": null,
      "platform": "MacIntel",
      "clientId": "openclaw-control-ui",
      "clientMode": "webchat",
      "roles": ["operator"],
      "scopes": ["operator.admin", "operator.read", "operator.write"],
      "remoteIp": "192.168.65.1",
      "browserOrigin": "http://192.168.1.88:3710",
      "isRepair": false,
      "requestedAtMs": 1789490956623
    }
  ],
  "approved": [
    {
      "deviceId": "848f99c9b0af…",
      "label": null,
      "platform": "MacIntel",
      "clientId": "openclaw-control-ui",
      "clientMode": "webchat",
      "roles": ["operator"],
      "scopes": ["operator.admin", "operator.read", "operator.write"],
      "remoteIp": "192.168.65.1",
      "approvedVia": "bootstrap",
      "createdAtMs": 1789492279000,
      "approvedAtMs": 1789492279000,
      "lastUsedAtMs": 1789492300000
    }
  ]
}
```

- A stopped agent answers `200` with `running: false` and empty lists.
- `requiresApproval` is `null` when neither `/startupz` nor the config can be read.
- `approvedVia`: `silent` (local connection, approved automatically), `owner` (approved
  by an operator), `bootstrap` (one-time link), or another OpenClaw value.
- Public keys and token values are never returned.

**Errors:** `404` unknown agent, `503` Docker unreachable, `502` the OpenClaw command
failed or returned incomplete JSON.

---

### `POST /api/agents/[id]/devices`
Approve or reject a pending request.

**Auth:** browser cookie

**Body:** `{ "action": "approve" | "reject", "requestId": "<requestId>" }`

**Response (200):** `{ "ok": true }`

**Errors:** `400` invalid action or `requestId`, `404` unknown agent, `409` agent not
running, `502` command failed.

---

### `PATCH /api/agents/[id]/devices`
Rename an approved browser. The label is preferred over the name the client reports.

**Auth:** browser cookie

**Body:** `{ "deviceId": "<deviceId>", "name": "Office laptop" }` — 1-64 printable characters

**Response (200):** `{ "ok": true }`

**Errors:** as for `POST`.

---

### `DELETE /api/agents/[id]/devices?deviceId=<deviceId>`
Revoke an approved browser (`openclaw devices remove`). It needs approval again the next
time it connects.

**Auth:** browser cookie

**Response (200):** `{ "ok": true }`

**Errors:** as for `POST`.

---

### `GET /api/agents/[id]/open-control-ui`
Where the "Open" buttons navigate, in a new tab. Redirects (`302`) to the agent's
Control UI.

**Auth:** browser cookie

The target host is the one the request reached Rev4a on (the `Host` header), with the
agent's published port — never a parameter, so the link cannot be sent to another host.

- Runs `openclaw dashboard --json` in the container and redirects to its `browserUrl`,
  with the host, the port and the `gatewayUrl` fragment parameter rewritten to that host
  and the published port. The link is single-use, expires after ten minutes, and pairs
  the browser with no approval.
- When no one-time link can be issued: redirects to the plain link
  `http://<host>:<port>/#token=<token>`, with the token read inside the container
  (`/root/.agent-token`, then `OPENCLAW_GATEWAY_TOKEN`).

A navigation, not a JSON call: the button opens this URL inside the click, so no tab
is left blank after an `await` and no popup can be blocked.

**Errors** (plain text, meant for the tab): `400` host not readable, `404` unknown agent,
`409` agent not running or no published Control UI port, `503` Docker unreachable,
`502` neither a one-time link nor a token available.

---

### `GET /api/agents/[id]/invite-link`
A Control UI link to send to someone else — the "Invite link" button in Browser access.
The browser that opens it passes gateway auth and waits in the agent's approval list;
nothing opens until an operator approves it.

**Auth:** browser cookie

**Response:**
```json
{ "url": "http://203.0.113.7:3710/#token=…", "loopbackHost": false }
```

- `url` is the plain token link. The host is the one the request reached Rev4a on
  (the `Host` header); the port is the agent's published Control UI port. The token is
  read inside the container with the entrypoint's precedence (`/root/.agent-token`,
  then `OPENCLAW_GATEWAY_TOKEN`), so it is the one the Gateway checks.
- `loopbackHost` is true when that host is `localhost`, `127.x` or `[::1]`: nobody else
  can reach the link.
- The gateway token is shared by every agent. Changing the agents token
  (`PUT /api/agents/token`) invalidates every link sent.
- `Cache-Control: no-store`.

**Errors:** `400` host not readable, `404` unknown agent, `409` agent not running, no
published Control UI port, or no browser approval on this agent (the link would open
with no approval), `502` approval state or token not readable, `503` Docker
unreachable.

---

### `GET /api/agents/devices-summary`
Browsers waiting for approval, per running agent — the "browser waiting" badge on the
agent list.

**Auth:** browser cookie

**Response:**
```json
{ "agents": [ { "agentId": "agent_2a3c3a07", "requiresApproval": true, "pending": 1 } ] }
```

- At most three agents are read at a time; one that cannot be read reports
  `error: true` and `pending: 0` without failing the others.
- `503` with `agents: []` when Docker cannot be reached.

---

### `GET /api/agents/activity-summary`
The long operation each agent is in the middle of, if any — the chip on the agent cards:
`BACKUP nn%`, `RESTORING`, `RECREATING`, `UPDATING`.

**Auth:** browser cookie or bearer token

**Response:**
```json
{ "agents": [
  { "agentId": "agent_9253eee3", "kind": "backup", "file": "agent-agent_9253eee3-cold-2026-09-17_163103795.tar.gz", "percent": 16 },
  { "agentId": "agent_2a3c3a07", "kind": "restore", "file": "agent-agent_2a3c3a07-cold-2026-09-21_172032317.tar.gz" },
  { "agentId": "agent_a0000011", "kind": "update", "version": "2026.9.3" }
] }
```

- `kind`: `backup`, `restore`, `recreate`, `update` or `edit`. A running cold backup takes
  precedence, because while its helper archives the volume that is the phase actually in
  progress (an update's or recreate's own backup phase reports `backup`).
- `percent` is only on `backup` (`null` until the archive size has been measured; the
  client renders `BACKUP…` then). `version` is on `recreate`/`update`.
- Idle agents are not listed: an idle system answers `{ "agents": [] }`.
- Read from the state modules (`agent_restores`, `agent_recreates`, `agent_upgrades`,
  `agent_edits`) and one Docker list call for the running backup helpers.

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
    "gateway": { "controlUi": { "dangerouslyAllowHostHeaderOriginFallback": true } },
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
Agents with a long operation in flight (update, recreate, restore, edit, backup) are
skipped and listed, and a container that could not be updated is reported instead of
being swallowed.

**Auth:** browser cookie

**Body:**
```json
{ "token": "new-token-value" }
```

**Response:**
```json
{ "success": true, "containersUpdated": 2, "skipped": ["agent_9253eee3"], "failed": [{ "container": "agent_x", "error": "…" }] }
```

**Side effects:**
- Writes the new token to `data/agents-token.json`
- Writes the token file (`/root/.agent-token`) into every running container with `AGENT_ID` label
- Restarts each container so the entrypoint picks up the new token via `OPENCLAW_GATEWAY_TOKEN` env

---

## Agent Image Management

### `GET /api/agents/image-status`
Which OpenClaw versions of the agent image are downloaded, and whether the registry
publishes a newer supported one.

**Auth:** browser cookie or bearer token

The registry tag list is read over the registry HTTP API (anonymous token for ghcr,
plain HTTP for a `localhost` registry), cached for 10 minutes and de-duplicated while
in flight, so polling this endpoint does not re-query the registry every time.

**Response:**
```json
{
  "downloading": false,
  "downloadingVersion": null,
  "downloadPercent": null,
  "downloadMessage": null,
  "canceled": false,
  "lastResult": {
    "version": "2026.9.3",
    "result": "succeeded",
    "source": "registry",
    "message": "OpenClaw 2026.9.3 image downloaded",
    "at": 1758700000000
  },
  "serverTime": 1758700004000,
  "exists": true,
  "needsUpdate": false,
  "localVersions": ["2026.9.3"],
  "newestLocal": "2026.9.3",
  "available": null,
  "registryReachable": true,
  "revisions": [
    { "version": "2026.9.3", "status": "current", "expected": "28cf675", "local": "28cf675" }
  ],
  "outdatedVersions": []
}
```

| Field | Description |
|---|---|
| `exists` | A supported version is downloaded as `openclaw-agent-base:<version>` |
| `needsUpdate` | `true` when none is, or when `available` is set |
| `localVersions` | Supported versions downloaded, newest first |
| `newestLocal` | The version new agents are created on |
| `available` | Newest supported version on the registry that is not downloaded and is newer than `newestLocal`, or null |
| `downloading` / `downloadingVersion` | A download running, and its version |
| `downloadPercent` | Fraction of layers finished, from `docker pull`'s own per-layer lines (`getDownloadProgress()`), 0-99. Null until it can be computed: while the version is resolved, while docker is still listing the layers, on a pull where every layer is already present, and on the local-build fallback |
| `downloadMessage` | The latest line of docker's output, verbatim (the banner shows it under the percent) |
| `canceled` | Whether the last finished download ended as cancelled — derived from `lastResult`, so a cancel that arrived after the image was already tagged does not make a successful download read as cancelled |
| `serverTime` | The server's clock (epoch ms) when it answered; clients age `lastResult.at` with it instead of their own clock |
| `lastResult` | The last download's outcome (`getLastDownloadResult()`, `lib/buildAgentImage.ts`), or null before any download has run this process. `result` is `succeeded` / `failed` / `canceled`; `source` (`present` / `registry` / `build`) only on success. Kept regardless of whether a download is running now, so a client that missed the live transition — a page reload, a return from another screen — still sees it via `at` (epoch ms); overwritten by the next download, never cleared on its own. Same idea as `finished` in `lib/cold-backup.ts` |
| `registryReachable` | The tag list could be read |
| `revisions` | One entry per supported version: `status` is `missing` (no local image), `current`, or `outdated` (a revision is pinned in `lib/agent-versions.json` and the local image's revision is unknown or different); `expected` is the pinned revision or null (also null when `REV4A_AGENT_IMAGE_REGISTRY` is set, which turns the pin off); `local` is the revision read from a local `<version>-rev.<sha>` tag on the image holding the `<version>` tag (the pinned one when the image carries several, else the first), or null |
| `outdatedVersions` | The versions whose status is `outdated`; the banner offers a download for them. `needsUpdate` does not include them |

### `POST /api/agents/download-image`
Downloads one OpenClaw version of the agent image in the background. Returns 202
immediately; the frontend polls `GET /api/agents/image-status` for completion.

**Auth:** browser cookie or bearer token

**Body (optional):** `{ "version": "2026.9.3" }` — a supported version. Without it, the
newest supported version the registry publishes.

**Response (202):**
```json
{ "started": true, "version": "2026.9.3" }
```

**Errors:** `400` unsupported version; `409` a download is already in progress; `503`
Docker is not available (refused here, before `202`, so the client gets the reason).

The download is `lib/buildAgentImage.ts` → `downloadAgentImage({ version, onEvent, signal })`:
- nothing to do when the local `openclaw-agent-base:<version>` is already the pinned build
  (`imageRevision` in `lib/agent-versions.json`), or, for a version without a pin, when it is
  present at all
- `docker pull <registry>:<version>-<pin>` (or `:<version>` without a pin), tag it
  `openclaw-agent-base:<version>` (and `openclaw-agent-base:<version>-rev.<pin>`), untag the
  registry reference; the previous build keeps an identity tag `<version>-rev.<12 hex>` so
  retention can remove it once unused — also when the tag step fails or is cancelled, so no
  `<registry>:<version>` reference is left behind (`pullAgentImage()` in `lib/agent-images.ts`)
- when a pinned pull fails while the version is already present, the job fails and nothing
  is touched; when the version is missing and the repository Dockerfile's
  `ARG OPENCLAW_VERSION` is that version, `docker build --build-arg OPENCLAW_VERSION=<version>`
  instead (that build has no revision tag, so it stays `outdated`); any other version fails
- one download at a time (in-process lock, `getIsDownloading()` /
  `getDownloadingVersion()`); docker's output also goes to
  `/tmp/rev4a-download-<timestamp>.log` (mode 0600; logs older than 24 h are removed when a download ends) for diagnosis
- progress: a layer counts as finished at `Pull complete` or `Already exists` (not at
  `Download complete`, which still has the extraction ahead); the percent is withheld
  until the first layer starts transferring — before that the layer list may be
  incomplete — never goes down, and stays below 100: completion is reported by
  `lastResult`, not by the percent

### `DELETE /api/agents/download-image`
Cancels the running download, if any (`cancelDownload()`): the `docker pull`/`docker build`
process is killed, or never started when the cancel arrives before it (`runDocker` refuses
an already-aborted signal, and the download checks after every wait). The rejected
`downloadAgentImage()` promise carries a distinct `'canceled'` message, so the route's
background `.catch` does not log it as a failure; `lastResult.result` becomes `canceled`.

**Auth:** browser cookie or bearer token

**Response (202):**
```json
{ "canceling": true }
```

**Errors:** `404` nothing is running — the download has not started yet, or has
already ended.

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
Machine metrics of the host Rev4a runs on — CPU, RAM, swap, storage — read from
`metrics.db` (written by the daemon every 30 s, see `docs/dev/DATABASE.md`): the latest
sample, live host facts, and a bucketed history for one range. The System page
(`/system`) and the dashboard's Machine card use it.

**Auth:** Bearer or browser cookie

**Query:** `range` — `1h` (default), `24h`, `7d` or `30d`; anything else answers `400`.
The range is cut into buckets of `bucket_s` seconds (about 120 points, never shorter than
60 s — two samples, so a timer that drifts a second leaves no false gaps), each with its
average and peak: 60 s for `1h`, 720 s for `24h`, 5040 s for `7d`, 21 600 s for `30d`.

**Response:**
```json
{
  "latest": {
    "ts": 1790419256, "age_s": 12, "cpu": 21.5,
    "ram_used_mb": 4779, "ram_total_mb": 7851, "swap_used_mb": 2048, "swap_total_mb": 4096,
    "load_avg_1m": 1.35, "load_avg_5m": 1.56, "load_avg_15m": 1.21,
    "disks": [
      { "mount": "/", "roles": ["root", "docker", "data"], "used_mb": 61440, "avail_mb": 38912, "total_mb": 102400, "percent": 61 }
    ]
  },
  "host": { "hostname": "vps", "platform": "linux", "cores": 4, "uptime_s": 290000 },
  "interval_s": 30,
  "range": "1h",
  "bucket_s": 60,
  "history": [ { "ts": 1790419230, "cpu_avg": 21.5, "cpu_max": 29.1, "ram_avg": 60.9, "ram_max": 61.2 } ],
  "disk_history": [ { "mount": "/", "points": [ { "ts": 1790419230, "percent": 61 } ] } ]
}
```

- `ts` values are in **seconds**; a `history` point's `ts` is the start of its bucket.
  Buckets with no samples are absent (the daemon was not running), not zero.
- `ram_used_mb` is total − available, the figure `free` shows (Linux `/proc/meminfo`); on
  macOS active + wired + compressed pages. `swap_*` are `null` where there is no swap
  figure. `ram_avg`/`ram_max` are percentages.
- `disks`: each filesystem once — `/`, Docker's data root (`docker info`), and Rev4a's
  data directory, merged when they are the same device; `roles` says which of the three
  it is. `percent` is used / (used + available), as `df` computes it.
- `latest` is `null` before the daemon's first sample (the database is created when the
  daemon starts, the first sample about 5 s later), and when `metrics.db` has no tables. `age_s` older than 3 × `interval_s`
  means the daemon is not sampling; the page says so.
- `host` is read live by the API process, which runs on the same host.

### `GET /api/metrics/containers?range=1h|24h|7d|30d`
What every container consumes — now, and as an average and peak over the range — plus what is
not a container and the disk Docker holds. From `metrics.db` (the daemon samples every 60 s,
see `docs/dev/DATABASE.md`). Default range `1h`.

**Auth:** browser cookie or Bearer

**Response:**
```json
{
  "available": true, "range": "1h", "interval_s": 60,
  "host": { "ncpu": 10, "mem_total_mb": 7837 },
  "sampled_at": 1790789760, "age_s": 10,
  "containers": [
    { "container": "agent_9253eee3", "name": "test", "agent_id": "agent_9253eee3", "is_agent": true,
      "running": true, "last_seen": 1790789760,
      "now": { "cpu_cores": 0.022, "cpu_percent": 0.22, "mem_mb": 668, "mem_percent": 8.5, "pids": 12,
               "net_rx_bps": 0, "net_tx_bps": 0, "blk_read_bps": 0, "blk_write_bps": 0 },
      "range": { "cpu_avg_percent": 1.02, "cpu_max_percent": 2.17, "mem_avg_mb": 679, "mem_max_mb": 701 },
      "storage": { "volume_mb": 1544, "layer_mb": 10, "total_mb": 1554, "ts": 1790789645 } }
  ],
  "rest": { "cpu_percent": 42.26, "mem_mb": 11864 },
  "docker_storage": { "ts": 1790789645, "images_mb": 4734, "images_reclaimable_mb": 3518,
                      "build_cache_mb": 1597, "build_cache_reclaimable_mb": 1597,
                      "volumes_mb": 10120, "unused_volumes_mb": 7337, "layers_mb": 30,
                      "unused_volumes": [ { "name": "rev4a-backups", "size_mb": 7337 } ] }
}
```

- `cpu_percent` is a share of Docker's cores (`host.ncpu`), `mem_percent` of Docker's memory —
  on Docker Desktop that is its VM, on the VPS the machine. `cpu_cores` is the raw figure.
- `now` is `null` for a container that is not running (no sample within 3 intervals of the
  newest sample — running is judged against the newest sample, not the wall clock, so a
  stopped daemon does not make every container look stopped);
  `running: false` ones stay listed while they were seen in the range. A rate that is null in
  the newest sample (the first after a start) is replaced by the previous reading.
- The list is sorted running first, then by CPU now. `storage` is the named volumes plus the
  writable layer, from the last Docker disk reading (every 10 min).
- `rest` is the machine's newest sample minus the running containers (the containers' CPU
  re-scaled to the machine's cores first, so on Docker Desktop the two shares still compare):
  the host, Rev4a and other software (`null` without a machine sample or Docker's figures).
- `docker_storage.*_reclaimable_mb` and `unused_volumes` (the 5 largest): what **no container
  uses** — images of older agent versions you may still roll back to count as such; a volume
  like the cold backups' is listed, not advised for removal. `volumes_mb` sums all volumes;
  `unused_volumes_mb` is the total of what no container uses, `unused_volumes` only names the
  five largest.
- `available: false` until the daemon has created the tables; with the tables present and no
  rows yet it answers `available: true` with an empty list.

**With `&container=<name>`** — that container's history, bucketed like `GET /api/metrics`:
```json
{ "available": true, "range": "1h", "interval_s": 60, "host": { "ncpu": 10, "mem_total_mb": 7837 },
  "container": "agent_9253eee3", "name": "test", "bucket_s": 120,
  "history": [ { "ts": 1790789640, "cpu_avg": 1.41, "cpu_max": 2.17, "mem_avg": 685, "mem_max": 701 } ],
  "storage_bucket_s": 1200, "storage_history": [ { "ts": 1790788800, "total_mb": 1554 } ] }
```
`cpu_*` are shares of Docker's cores, `mem_*` MB. A container that was not running has no
points for that stretch (a gap). A name that matches the rules but was never sampled answers
`available: true` with an empty history.

**Errors:** `400` for another `range` or an invalid container name. A `metrics.db` that
cannot be opened (missing, corrupt) answers `available: false`, not an error.

### `GET /api/metrics/alerts?limit=10`
The latest `system_anomaly` events: the machine (CPU above 85 % or memory above 90 % on two
samples in a row, a disk at 90 %) and the containers (`container_pids`: 1 000 processes on two
samples in a row; `container_memory`: 90 % of Docker's memory on five), newest first, from `events.db`. `limit` 1–50, default 10.

**Auth:** browser cookie or Bearer

**Response:**
```json
{ "alerts": [ { "ts": 1790789625355, "metric": "disk", "message": "Disk high: / 94% used", "threshold": 90, "values": [94] } ] }
```
`ts` is in **milliseconds** (the `events` table's unit); `metric` is `cpu`, `ram`, `disk`, `container_pids`, `container_memory` or `null`.

---

## System Health

### `GET /api/system-health`
Aggregated checks of the runtime, cron jobs and usage cost, with recommendations. It
does not report CPU, RAM or disk (those are in `GET /api/metrics`). Its `runtime.heartbeat`
check ("Daemon heartbeat") reads the age of the newest machine metrics sample in
`metrics.db`: it shows the daemon is alive, not that the OpenClaw session poll ingests —
the two run on separate timers. A `metrics.db` that cannot be read makes this one check
say so; it does not fail the others.

**Auth:** browser cookie or bearer token

**Response:**
```json
{
  "health": "ok",
  "checks": [
    { "id": "runtime.sessions", "label": "Runtime sessions", "health": "ok", "value": 1, "details": "last session activity 3m ago", "source": "runtime" }
  ],
  "recommendations": [
    { "id": "cost.review-usage-based", "severity": "warning", "source": "cost", "title": "High spend today", "details": "…", "actionHref": "/costs", "dismissible": true, "createdAt": "2026-09-26T10:00:00.000Z" }
  ],
  "generatedAt": "2026-09-26T10:00:00.000Z"
}
```

Checks: `runtime.sessions`, `runtime.heartbeat`, `runtime.errors24h`
("Failed runs (24h)": the failure events of the last 24 hours — the `events` rows whose
`type` is `fail` or `spawn_timeout`, the two types `daemon.js` writes for a failed run
and for a sub-agent that timed out; the `events.ts` column is in milliseconds and any
count above zero is a warning that raises the `runtime.review-errors` recommendation),
`cost.usageBasedToday` ("Spent today": the agents' spend today, UTC day, from `costs.db`;
a warning above $10 or with calls without a price, each with its recommendation,
`cost.review-usage-based` / `cost.unpriced-calls`), `cron.jobs`. `health` (overall and per check) is `"ok"` /
`"warning"` / `"error"`; a recommendation's `severity` is `"info"` / `"warning"` /
`"critical"`. `generatedAt` and `createdAt` are ISO strings.

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

**Auth:** Bearer token or the `rev4a_token` browser cookie

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
Every Docker container, running or stopped, with its identity and network details. What a
running container consumes lives in `GET /api/metrics/containers`.

**Auth:** browser cookie or Bearer

**Response:** a bare array —
```json
[
  { "id": "a1b2c3d4e5f6", "name": "openclaw-atlas", "image": "openclaw-agent-base:2026.9.3",
    "status": "Up 3 hours", "state": "running", "ports": "0.0.0.0:3731->3000/tcp",
    "ip": "172.18.0.2", "agentId": "agent_atlas", "displayName": "Atlas", "created": null }
]
```

- `name` is the daemon's `primaryName` (the name with one leading slash) — the same key the
  metrics store and the `/system?agent=` link use.
- `displayName` is the agent's `AGENT_NAME`, read from the inspect. If an inspect fails, the
  row still comes from Docker's list (`ip` and `displayName` then `null`): a container is
  never dropped, and never renamed, because one call failed.

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
Return the installed Rev4a version, read from `package.json`.

**Auth:** `rev4a_token` cookie or `Authorization: Bearer <REV4A_TOKEN>`

**Response:**
```json
{ "version": "1.4.0" }
```

**Fallback:** `{ "version": "0.0.0" }` if `package.json` cannot be read.

### `GET /api/terminal-ws` (WebSocket)

The container terminal. A WebSocket upgrade on the dashboard's own port, handled by
`server.js` (not a Next.js route) and forwarded to `terminal-ws-server.js` on
127.0.0.1:3741 (`TERMINAL_WS_PORT`).

**Auth:** browser cookie only (`rev4a_token`), and `Origin` must equal the host — no bearer.

**Query:** `id` — the container name or id; `session` — a UUID naming the shell, so a
reconnect with the same value resumes it (up to 2 minutes after a drop); `resume=1` — the
page is reconnecting to a shell it had: if that shell is gone the server closes with
`4002` instead of starting a new one.

**Refused at the handshake**, in this order: `404` any other upgrade path, `403` Origin
not the addressed host (`Host` or `X-Forwarded-Host`), `401` no or bad cookie, `400` bad
container name, `503` Rev4a not started with `rev4a serve` (no terminal secret),
`502`/`504` the terminal server refused or did not answer.

**Messages:** client → server: keystrokes as text, or `{"type":"resize","cols":n,"rows":n}`;
server → client: terminal output. Close codes (`4001` shell exited, `4002` idle, or a resume
found the shell gone, `4003` opened in another tab, `4404` no container, `4409` stopped,
`4410` no shell, `4429` too many shells, `4500` PTY failed) are listed in [CONTAINER-TERMINAL.md](../CONTAINER-TERMINAL.md#close-codes).

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
A fixed list of environment keys, for diagnostics: `REV4A_PASSWORD`, `REV4A_TOKEN`,
`REV4A_JWT_SECRET`, `REV4A_ALERTS_ENABLED`, `REV4A_DB`, `REV4A_WORKSPACE_ROOT`,
`PROVIDER_DEEPSEEK_API_KEY`, `NODE_ENV`. It is not a dump of the process environment:
keys outside that list are never returned.

The four secrets — `REV4A_PASSWORD`, `REV4A_TOKEN`, `REV4A_JWT_SECRET` and
`PROVIDER_DEEPSEEK_API_KEY` — are reported as `set` or `not set` only. No part of their
value is returned, not even a prefix. The other keys return their value, or `(not set)`
when missing or empty.

**Auth:** browser cookie or bearer token

**Response:**
```json
{
  "REV4A_PASSWORD": "set",
  "REV4A_TOKEN": "not set",
  "REV4A_JWT_SECRET": "set",
  "REV4A_ALERTS_ENABLED": "1",
  "REV4A_DB": "(not set)",
  "REV4A_WORKSPACE_ROOT": "/workspace",
  "PROVIDER_DEEPSEEK_API_KEY": "set",
  "NODE_ENV": "production"
}
```

### `GET /api/provider-usage`
Usage and quota state per provider, including live OpenRouter figures.

**Auth:** browser cookie or bearer token

**Response:** `{ "providers": [...], "openrouterLive": {…}, "quotas": {…} }`

### `GET /api/update-check`
Installed version against the latest published one.

**Auth:** browser cookie or bearer token

**Query params:** `check=1` queries the registry; without it the answer comes
from local state only.

**Response:** `{ "installed": "1.4.2", "latest": "1.5.0", "updateAvailable": true, "package": "@flame0510/project-aether", "log": "update.log" }`

`updateAvailable` is recomputed against the version reading the request, even when the
registry answer comes from the fifteen-minute cache: reusing the cached flag made the
banner offer an update that had just been installed, right after an update.

`installed` is `null` when `package.json` cannot be read — during an update npm rewrites
it, and a transient failure must not look like a version. With `installed` unknown there
is nothing to compare, so `latest` is `null` and `updateAvailable` false. `installed` is
never a placeholder like `0.0.0`. `log` is the file name, in the Rev4a data directory,
where the update's output is written.

### `POST /api/update-check`
Run `rev4a update` as a detached background process. Nothing here restarts anything:
the update kills this process on its way in (`fuser -k <port>/tcp`) and `rev4a serve`
brings the child back on the new binary via its `.restart-flag`, so the connection
drops and the page has to wait for the server to answer again.

The child's output goes to `update.log` under `<REV4A_DATA_DIR>/data` (or
`~/.config/rev4a/data` by default) — the update restarts the process that spawned
it, so that file is the only record of what happened. The endpoint creates the
directory if needed and reports a failure if it cannot start the updater.

**Auth:** browser cookie or bearer token

**Response:** `{ "success": true, "message": "...", "log": "update.log" }`

The banner records what it asked for, polls `/api/update-check` until the installed version
moves (or two minutes pass), reloads, and on the next mount either confirms
"Updated to vX" or reports that the update did not complete and points at the log.

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
