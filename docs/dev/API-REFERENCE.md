# Rev4a API Reference

> **Last updated:** 2026-11-14

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

The JWT includes `pwf`: the first 22 base64url characters of HMAC-SHA256 keyed
by `REV4A_JWT_SECRET` over the fixed label `rev4a:session-password:v1\0` followed
by the effective password. The password itself is never included. After signature
and expiry verification, API authentication, protected pages and terminal WebSocket
upgrades compare this claim in constant time against the current password's
fingerprint. A missing, malformed or different claim is unauthenticated; an empty
password cannot authenticate a cookie session. Password resolution is
`process.env.REV4A_PASSWORD || .env value`, as at login. A Config password change
therefore ends existing browser sessions once applied after restart. Bearer
authentication remains independent of the password.

**SEC-21 upgrade:** every browser must log in once after updating, because cookies
issued by earlier releases have no `pwf`. No stored data or configuration migration
is needed; cookie flags and the 7-day lifetime are unchanged.

### Browser write protection (SEC-18)

`proxy.ts` checks every POST/PUT/PATCH/DELETE to `/api` or `/api/*` carrying the
`rev4a_token` cookie and no `Authorization` header, before route authentication:

- Literal `Origin: null` is always refused. Otherwise, `Sec-Fetch-Site: same-origin`
  is accepted first, even with a mismatched or malformed `Origin`. The browser computes
  this metadata from the real page and target URLs, including behind a proxy rewriting `Host`.
- Without that same-origin metadata, a present `Origin` must be well-formed and its
  host and port must equal `Host` (case-insensitive), or its full
  origin must be listed in `REV4A_ALLOWED_ORIGINS` (comma-separated HTTP(S) origins,
  e.g. `https://rev4a.example.com`). Schemes and ports are significant for the allowlist;
  sibling subdomains, wildcards and forwarded headers do not grant trust.
  Host and Origin use the Origin scheme to normalize default ports: explicit and
  implicit HTTP :80 / HTTPS :443 match; non-default ports must still match exactly.
- Without `Origin`, `Sec-Fetch-Site: cross-site` and `same-site` are refused.
  `same-origin`, `none` and missing metadata are allowed for older browsers and clients.

Refusals return **403** `{ "error": "Cross-site request refused" }`. Requests with any
`Authorization` header bypass this check; the route still owns authentication.
GET/HEAD/OPTIONS and requests without the session cookie are unaffected. The update guard
runs first and retains its existing 503 response and exemptions. This check applies to
update-exempt routes too. It does not replace the terminal WebSocket's own Origin check.

Normally no setting is required. For an older browser without fetch metadata behind a
reverse proxy that rewrites `Host`, list only the dashboard's trusted public origins in
`REV4A_ALLOWED_ORIGINS` and restart Rev4a.

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
Sets `Set-Cookie: rev4a_token=<jwt>; HttpOnly; Secure; SameSite=Strict` in production.
Development or `REV4A_FORCE_INSECURE_COOKIE=1` uses a non-Secure cookie with `SameSite=Lax`.

**Error:** `401` if the password is wrong or the server is not configured; `500` for an unreadable body.

**Throttle:** failed attempts are counted per client address, in memory. The first 5 failures in an hour are free; from the 6th the address is locked for 30 s, doubling with each further failure (60 s, 120 s, ...) up to 15 minutes. While locked the route answers `429` with `{ "error": "Too many failed attempts. Try again in <time>." }` and `Retry-After: <seconds>` (integer, rounded up, at least 1) **without checking the password**, so a correct password during a lock is refused too. A successful login clears the address; failures older than an hour are forgotten, but while an address keeps failing its lock does not fall back below the level it reached (it starts from zero after an hour without a failure). A wrong or empty password and an unreadable body count as failures; "server not configured" does not. Other addresses are not affected. An IPv6 client is counted per /64. `X-Forwarded-For` (rightmost entry) is honoured only from peers listed in `REV4A_TRUSTED_PROXIES`; with it unset no peer is trusted, loopback included, and every client is keyed by its socket address (see REV4A.md, auth flow). A proxy that is not trusted, or one that sends no header, puts every visitor under one address, and one lock then covers them all. The address is `x-rev4a-client-ip`, set by `server.js` (see ARCHITECTURE, Login throttle). Counters reset when Rev4a restarts. Bearer-token calls and the terminal WebSocket are not throttled.

### `GET /api/auth/check`
Validate the current browser cookie and report whether the user is authenticated.

**Auth:** browser cookie

**Response:**
```json
{ "authenticated": true }
```

**Error:** `401` with `{ "authenticated": false }` if the cookie is missing, invalid,
has no `pwf` claim or no longer matches the current effective password. This endpoint
remains cookie-only; a Bearer token does not authenticate a browser session.

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

While no password exists, **every endpoint in this section** requires header
`x-rev4a-setup-code`. `rev4a serve` prints a new random code at each unconfigured
start with `[SETUP]` in its terminal or service journal (`journalctl -u rev4a`). A
direct Next.js start generates and logs one on its first setup request. Input is
trimmed, case-insensitive, and ignores dashes/spaces; comparison is constant-time.
Missing or wrong codes return `403`:

```json
{ "error": "Setup code required: it is printed in the terminal (or the journal) where rev4a serve runs" }
```

After configuration the setup code is ignored: cookie/bearer authentication applies
to wizard, image and restart routes. Password setup instead always returns `409`.
Configured installations generate and print no setup code.

### `GET /api/wizard/status`
Whether the first-run wizard has been completed.

**Auth:** setup code before configuration; browser cookie or bearer token afterwards

**Response:** `{ "done": true }`

### `POST /api/wizard/complete`
Mark the wizard as completed.

**Auth:** setup code before configuration; browser cookie or bearer token afterwards

**Response:** `{ "done": true }`

### `POST /api/wizard/reset`
Reset the wizard so it runs again.

**Auth:** setup code before configuration; browser cookie or bearer token afterwards

**Response:** `{ "done": false }`

---

### `POST /api/setup/password`

Set the dashboard password during first-run setup.

Password setup writes `.env` with mode `0600` and chmods it to `0600` after writing,
including an existing file with broader permissions.
It generates `REV4A_JWT_SECRET` and `REV4A_TOKEN` when their last parsed assignment is
missing or empty (including `KEY=`, `KEY=""`, `KEY=''` and comment-only values), unless the service environment already provides a non-empty
value for that key (the same rule as startup in `rev4a serve`).
An empty assignment is replaced; non-empty secrets and unrelated lines are preserved.

**Auth:** setup code, and only usable once — returns `409` if a password already exists

**Body:** `{ "password": "..." }` — minimum 8 characters

**Errors:** `400` invalid JSON, missing/non-string password, fewer than 8 characters,
or a value containing CR, LF or NUL (names `REV4A_PASSWORD`), or a password `.env` cannot
hold faithfully (contains `$`, or a single quote combined with leading/trailing spaces, `#`
or a leading quote; same rules as `PUT /api/config/env`); `403` missing/wrong setup
code; `409` already configured, including a request paused reading its body while
another request finished setup, or an existing `.env` with multi-line/ambiguous values; `500` the `.env` file could not be written. The file
is freshly read and configuration synchronously rechecked immediately before writing.

**Response:** `{ "status": "ok" }`

### `POST /api/setup/restart`
Restart the service so a freshly written `.env` takes effect.

**Auth:** setup code before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Errors:** `400` if the last parsed `REV4A_PASSWORD` in `.env` is empty or missing;
`500` if the `.env` file is missing, or the restart could not be issued.

### `GET /api/setup/agent-image`
Whether a supported OpenClaw version of the agent image is downloaded.

**Auth:** setup code before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

**Response:** `{ "exists": true, "version": "2026.9.3" }` (the newest one present), or
`{ "exists": false, "version": null }` when none is **or Docker is unreachable** — the two
are not distinguished.

### `POST /api/setup/agent-image`
Download the newest supported version the registry publishes, streaming progress as SSE
(`status`, `progress`, `step`, `log`, `complete`, `error`). Nothing is downloaded when
that version is already here as its pinned build (the same rules as
`POST /api/agents/download-image`).

**Auth:** setup code before a password exists, then browser cookie or bearer token (`requireAuthIfConfigured`)

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
could not be read — except a missing gateway key on an install with no agent
containers (a fresh install): that sync reports `ok: true` and
`No agent containers to sync.` with no `configError`.

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

A model id sent as `subscription:openai/<id>` is a ChatGPT subscription model, stored as a bare
`openai/<id>`; see [`PUT /api/gateway/agent` and subscription models](#put-apigatewayagent-and-subscription-models)
for the mark, its checks (409 when the agent has no ChatGPT sign-in) and what happens to stored fallbacks.

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

**Error (502):** upstream request or body-read failure, including a malformed stored key:
```json
{ "error": { "message": "Gateway error: the upstream request failed", "type": "gateway_error" } }
```
The raw exception message is never returned or logged; only its name and optional
code are logged. Stored upstream keys with ASCII control characters are refused
before fetching. `POST /api/gateway/provider` rejects such keys with `400` before
trimming, writing or syncing (see [PROVIDERS.md](PROVIDERS.md)).

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

## Config

### `GET /api/config/env`
Read stored and runtime variables with `REV4A_` or `PROVIDER_` prefixes.

**Auth:** browser cookie or bearer token

**Response:** `{ "env": { "REV4A_PASSWORD": "...", ... } }`

Per-process keys are never included, from either the file or runtime environment:
`REV4A_SERVER_PID`, `REV4A_STARTED_AT`, `REV4A_RUNNING_VERSION`,
`REV4A_TERMINAL_SECRET` and `REV4A_SETUP_CODE` (the shared
`RUNTIME_ONLY_ENV_KEYS` list in `lib/env-file.js`). Other allowed keys absent from
the file are supplemented from `process.env` for display.

File values use the shared `lib/env-file.js` reader, also used by the launcher,
authentication fallbacks, password setup and setup/restart: dotenv-style inline
comments are stripped from unquoted values, matching quotes are removed, quoted
`#` stays literal, double-quoted `\n`/`\r` are decoded and the last assignment wins,
including an empty one. CRLF, CR, LF, `export KEY=` and `KEY: value` are accepted.
Reading does not rewrite the file. Next.js's `$` expansion is separate; new writes
containing `$` remain refused.

### `PUT /api/config/env`
Update environment variables on the VPS host.

**Auth:** browser cookie or bearer token

**Body:** `{ "env": { "REV4A_PASSWORD": "newpass", ... } }`

**Side effects:**
- Patches the persistent data directory's `.env` (linked from the project root)
  by physical line, preserving CRLF, CR and LF separators. The last assignment of an
  edited key is replaced with `KEY=value` and its earlier duplicates are removed;
  clearing a stored non-empty value removes every assignment of that key. An absent
  non-empty key is appended. Rev4a edits `.env` automatically only when every line is blank, a comment or a one-line `KEY=value` (a quoted value closing on the same line). A file with a multi-line or unterminated quoted value, a value on the next line, text after a closing quote (including an inline comment such as `REV4A_TOKEN="t" # comment`), or a backslash immediately before a same-kind quote (including the closing quote) is ambiguous across tools: an edit then answers `409` and writes nothing (edit the file by hand), and the startup repair of runtime keys is skipped with a log line. Unchanged values, including inherited multi-line ones, are never an edit.
  Every other line, including unknown operator keys, comments, blank lines, order
  and line endings, is preserved. Stored parsed values are compared first, so
  unchanged empty assignments (`KEY=`, `KEY=""`, `KEY=''`) retain their original bytes. An unchanged full GET-to-PUT round trip
  performs no write
- Runs `systemctl daemon-reload` after a file change so the next restart picks up
  the new environment; a no-op save neither writes nor reloads
- Writes with mode `0600`, then explicitly chmods `.env` to `0600`, including an
  existing file left at `0644`. At startup the launcher independently tightens
  overly broad `.env` permissions and logs the repair once; no content change is
  needed for that repair
- Only keys prefixed with `REV4A_` or `PROVIDER_` are accepted. Runtime-only keys
  listed above are silently ignored, so older open tabs can still save
- An absent key whose submitted value equals `process.env[key]` is ignored: it is
  an unchanged GET-injected value. A different non-empty value is a new setting
- Clearing a key absent from the file but non-empty in `process.env` rejects the
  entire request with `400`: `This value comes from the service environment, not .env; change it there.`
  Nothing is written or reloaded. Config displays the message and does not restart
- The Config client sends only values that differ from its last loaded/saved
  snapshot, including explicit clears
- Submitted keys use the shared assignment validator, which permits legacy dotted
  keys but rejects whitespace, control characters, `=` and a leading `#`.
  New or changed non-runtime values must be strings without CR, LF
  or NUL. Validation runs before any write. Clearing a stored non-empty value removes the key;
  space-only strings keep their previous behaviour. Non-string values, including
  `null`, are `400` rather than coerced or treated as removal

**Response:** `{ "status": "ok", "updated": ["REV4A_PASSWORD", ...] }`
`updated` lists keys whose assignment changed; ignored and unchanged keys are omitted.

**Writing:** values are serialised so Next.js and Rev4a read them back exactly (`#`, leading/trailing spaces or a leading quote -> single-quoted). `400` for a value containing `$` (`The value for <key> contains '$': Next.js expands it ...`: Next expands `$VAR` even single-quoted and overrides the launcher's value), for one that cannot be represented (a single quote together with leading/trailing spaces, `#` or a leading quote; a trailing backslash inside quotes: `The value for <key> cannot be stored in .env as typed ...`), or containing U+2028/U+2029 (`... contains a Unicode line separator ...`). `409` when `.env` itself is not plain (multi-line or ambiguous values): edit it by hand.

**Errors (400):** `Keys not allowed: ...`, `Invalid environment key: <key>`, or
`Invalid value for <key>: must be a string without CR, LF or NUL characters`.
An inherited-only clear returns `This value comes from the service environment, not .env; change it there.`

**Errors (500):** file read or write failure. Only ENOENT (a missing file) permits
starting from an empty file; any other read error aborts before writing. Password
setup, `writeEnvVar()` and the launcher's default configuration generation follow
the same rule.

### `POST /api/config/restart`
Restart the Rev4a server (via systemd).

**Auth:** browser cookie

**Response:** `{ "status": "ok", "message": "Service restarted" }`

---

## Sessions

### `GET /api/sessions`
Sessions of every agent, read from the `agent_sessions` table of `events.db` (filled by the daemon
from each agent's container). Default: running now or updated in the last 7 days, newest first, at
most 2000. Cron runs do not crowd out the other kinds: the other sessions are listed first and only the
newest 20 runs of each cron job (plus any run still running) fill what is left of the cap (`kind=cron_run` asks for them all, up to the
cap). Until the daemon has written the table the answer is empty, never an error.

**Auth:** browser cookie

**Query params (all optional):** `container`, `kind` (main, subagent, cron, cron_run, explicit, custom, direct, dashboard), `since` (ms; replaces the 7-day window), `active=1` (running only), `limit` (max 2000).

**Response:**
```json
{
  "sessions": [
    {
      "uid": "rev4a-agent_1|agent:main:subagent:3f2c",
      "container": "rev4a-agent_1", "agent_name": "Atlas",
      "session_key": "agent:main:subagent:3f2c", "session_id": "…",
      "kind": "subagent", "parent_uid": "rev4a-agent_1|agent:main:main",
      "parent_kind": "spawn", "spawn_depth": 1, "label": "Hygiene",
      "status": "done", "last_error": null,
      "model": "gpt-5.4", "provider": "openai-codex",
      "input_tokens": 12500, "output_tokens": 3200, "total_tokens": 15700,
      "cost_usd": null, "uses_subscription": true, "cron_job_id": null,
      "started_at": 1749200000000, "updated_at": 1749201000000, "ended_at": 1749201000000,
      "archived_at": null, "gone_at": null,
      "id": "agent:main:subagent:3f2c", "parent_id": "agent:main:main"
    }
  ],
  "total": 1,
  "version": 42
}
```

`parent_uid` is set only when the parent row exists in the same container (`parent_kind` is `spawn` for a
real sub-agent link, `cron` for a cron run, `nav` for a navigation parent). `cost_usd` is `null` when
OpenClaw did not price the session, never 0. `uses_subscription` is `true` when the session runs on a
ChatGPT subscription (`openai` or `openai-codex`, the `isSubscriptionProvider` rule in
`lib/agent-costs.ts`); when the session's `provider` is `null`, the `provider` of the matching
`costs.db` `agent_cost_sessions` row for the same `(container, session_id)` decides. The Lineage shows
`subscription` instead of a dollar amount for such a session; `cost_usd` still carries OpenClaw's
figure and is not changed. The field is on every session object of `GET /api/sessions`,
`GET /api/session`, `GET /api/sessions/[id]` and the SSE `sessions` frame. `id` and `parent_id` are the old field names, kept for
one release. `version` changes whenever the daemon stored a change. `total` is the real number of matching
sessions: when it is larger than `sessions.length` the list was capped, and the Lineage page shows
"Showing N of M sessions".

---

### `GET /api/session?container=<name>&key=<session_key>`
One session with its events (the newest 20) and child sessions (rows whose parent is this key, same container; up to 50).

**Auth:** browser cookie

**Query params:** `key` (required), `container`. The old `id=<session key>` is accepted for one release and answers `400` when the key exists in more than one container.

**Response:**
```json
{ "session": { ...session... }, "children": [ ...sessions... ], "events": [ ...event rows... ] }
```

Events are those whose `data` carries this container; older events without it do not appear.

**Errors:** `400` missing key or ambiguous key; `404` not found.

---

### `GET /api/sessions/[id]`
Same as `GET /api/session`, with the session key in the path (`?container=` optional; `400` when ambiguous).

**Auth:** browser cookie or bearer token

**Response:** `{ "session": {…}, "events": [...], "children": [...] }`

**Errors:** `404` if the session does not exist.

---

## Costs

Agent costs come from `costs.db`: what each agent's own OpenClaw priced, copied by the
daemon (the queries are in `lib/agent-costs.ts` (spend) and `lib/cost-reconciliation.ts` (`vendor_balance`), on a read-only handle from `lib/costs-db.ts`). `GET /api/costs/usage` feeds the Costs
page, `GET /api/costs` the dashboard, `GET /api/costs/agent` the agent panel. `GET /api/stats`
and `GET /api/stats-since` were removed with the lineage rework; spend is only in `costs.db`.

### `GET /api/costs/usage?range=today|7d|30d`
What the agents spent in a range of UTC days, today included (default `7d`), read from
`costs.db` (written by the daemon every 5 minutes, see `docs/dev/DATABASE.md`). Rev4a
computes no cost: every figure is the one OpenClaw recorded with the prices Rev4a syncs.
Calls made with a ChatGPT subscription (provider `openai` or `openai-codex`) are left out of the spend in `totals`,
`daily`, `byAgent`, `byModel` and `proxy` (they are covered by the plan) and reported in `subscription`.
`sessions` keeps a session whose current provider is a subscription, with `usesSubscription: 1`. The
unpriced counts (`missing`, `unpriced`) stay as OpenClaw recorded them, subscription models included:
taking them out could hide an unpriced paid model.

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
  },
  "subscription": {
    "totals": { "tokens": 52000, "calls": 14, "apiValue": 0.41, "unpricedCalls": 0 },
    "byAgent": [ { "container": "agent_9253eee3", "name": "test", "tokens": 52000, "calls": 14, "apiValue": 0.41, "unpricedCalls": 0 } ],
    "byModel": [ { "provider": "openai", "model": "gpt-5.4", "tokens": 52000, "calls": 14, "apiValue": 0.41, "unpricedCalls": 0 } ],
    "unpriced": []
  }
}
```

- `subscription` (additive): the calls made with a ChatGPT subscription over the range, kept out of every
  figure above. `apiValue` is what the calls would have cost at OpenAI API prices (OpenClaw's price
  catalog, refreshed every 6 hours): the saving the plan gives, not a spend. A model OpenClaw has no price
  for records tokens with cost 0: its calls are counted in `unpricedCalls` / `unpriced` (the page shows
  "no price", and "at least" on the total). Empty (`calls` and `tokens` 0) when there are none.

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
  authenticated agent proxy token; legacy shared-key/`REV4A_API_KEY` callers still use
  `x-rev4a-agent`, with its existing bounded resolution): `recorded` is OpenClaw's, `metered`
  the proxy's (`null` when nothing went through the proxy), `combined` the larger of the two, `gap` the
  proxy's excess (0 if none), `flagged` true when the proxy saw more than 20 % and more than 0.10 USD above
  the agent (never true for `unknown` and `assistant`, which have no recorded figure). Proxy rows
  under both an agent's AGENT_ID and its container name are merged into that agent before `combined` is computed. Agents left out of `byAgent` (stopped, nothing recorded in the range) are still paired by AGENT_ID or container name, with a recorded figure of 0.
  Token ids retained in the historical `agent_cost_sources` known set still receive
  attribution after deletion, exactly like legacy headers naming them. Deletion removes
  the container holding the token; revoke copied tokens by rotating the shared gateway
  key, then sync running agents for fresh tokens (stopped containers also sync).
  Callers no known agent claims are listed on their own with `container`/`name` null:
  `agent: "unknown"` (a token id outside that set, or a legacy caller without a valid
  accepted header; token identities ignore the header) and
  `agent: "assistant"` (PULSE). `recordedCost`, `meteredCost` and `combinedCost` are sums over those
  lines; `combinedCost` is the spend the page counts. The `unknown` line keeps its metered figures but its
  `combined` is 0: unidentified calls may be an agent's own spend that the agent already
  recorded (an agent not yet synced), so adding them would count it twice; `assistant` is added (PULSE
  is recorded nowhere else). `available: false` (no lines) when `costs.db`
  has no `proxy_usage_hourly` yet, or when reading it failed; `totals`, `daily` and the other lists are unchanged and stay the
  agents' own figures.
- `available: false` (zeros, empty lists) until the daemon has created `costs.db`.

**Errors:** `400` for another `range`; `500` when `costs.db` cannot be read.

---

### `GET /api/costs`
The dashboard's figures (without ChatGPT subscription calls): today's spend (UTC day), all-time spend, today's calls without a
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
"cost": 0.022 }, "unpricedMonth": 81, "subscription": null, "collectedAt": 1790529516737, "error": null }` —
UTC days (today, last 7, last 30); `pricing` is the band billed right now, the same object
the Costs page header shows (`null` when no scheduled model is on offer); `collectedAt`/`error`
`subscription` is `{ tokens, calls, apiValue, unpricedCalls }` over the 30 days when the agent made calls with a ChatGPT subscription (covered by the plan, not in the figures above), `null` otherwise;
from the agent's last read. Before `costs.db` exists, the response is
`{ "available": false, "intervalS": 300, "pricing": null }` (or the current pricing
object when a scheduled model is on offer).

**Errors:** `400` for an invalid container name; `500` when `costs.db` cannot be read.

---

## Events

### `GET /api/events?limit=50`
The newest events, newest first. There is no `offset`.

**Auth:** browser cookie

**Query params:** `limit` (default 50, clamped to 1-500)

**Response:**
```json
[
  {
    "id": 1042,
    "ts": 1749201500000,
    "session_id": "agent:ops:subagent:uuid",
    "type": "subagent_spawned",
    "data": "{\"container\":\"rev4a-agent_1\"}",
    "session_label": "Hygiene",
    "agent_name": "Atlas",
    "container": "rev4a-agent_1"
  }
]
```

Each row also carries `session_label` and `agent_name` (from the session row of the same container, `null` when there is none) and `container` (from `data.container`, `null` for events without one).

---

### `GET /api/stream`
Server-Sent Events stream. Every 5 s it sends one message per kind, each `{ type, data }`:
`events` (new rows of the `events` table, only when there are any), `sessions` (the same `Session[]` as
`GET /api/sessions`, at most 2,000, sent on the first poll and then when the daemon changed the
sessions table or when `costs.db` got new costs (costs are filled at read time; each poll reads only
the version and one aggregate of `costs.db`, the list is rebuilt only when one moved); the message also carries `total`, the real number of sessions) and `costs` (`{ "today": … }`, what the agents spent
today, UTC day — the same figure as `GET /api/costs`).

**Auth:** browser cookie or Bearer

**Event format:**
```
data: {"type":"sessions","data":[...],"total":120}
data: {"type":"costs","data":{"today":0.0112}}
```

Use `EventSource` in the browser or `curl -N` for testing.

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
  `openclaw --version` inside the running container (cached per Docker container id and
  image id, or name + image id without a container id; ten minutes on success, five on
  failure; only metadata is cached per image id). A stopped agent whose image carries
  neither returns its own unexpired cached exec version, or `null` without one. Exec-derived versions
  remain available for display and update planning, but never select recreate/edit images.
  Malformed image tag arrays (including any non-string element) are treated as
  unknown metadata; they do not fail the agent listing.
- `updateAvailable` is `true` when a newer supported OpenClaw version is downloaded.
- `newBuildAvailable` is `true` when the image this release pins for the agent's version is
  downloaded and the agent's container runs a different image id (a recreate moves it).
  The version must come from image metadata (including inspection by id); an exec-only
  legacy version never produces this prompt because recreate retains that image id.
- `controlPort` is the host port published for the Control UI. No link or token is
  returned: the Open buttons go through `GET /api/agents/[id]/open-control-ui`
- Containers are discovered via Docker API with label filter `AGENT_ID`
- Template is inferred from the container image name + agent ID directory match in `agent-templates/`

---

### `GET /api/agents/gateway`
Whether each agent's Gateway has finished starting. Docker reports a container `running` at
once; the Gateway inside needs seconds to minutes. The list route answers from Docker alone, so
this one runs a readiness probe inside each running container.

**Auth:** browser cookie

**Response:**
```json
{
  "agents": {
    "prometheus": { "state": "ready", "startedAtMs": 1760000000000, "blocksOpen": false, "checkedAtMs": 1760000123456 },
    "atlas": { "state": "starting", "startedAtMs": 1760000100000, "blocksOpen": true, "checkedAtMs": 1760000123456 },
    "argus": { "state": "stopped", "startedAtMs": null, "blocksOpen": false, "checkedAtMs": 1760000123456 }
  }
}
```

**Notes:**
- `state` is `stopped`, `starting`, `ready`, `not_ready` or `unknown` (`lib/gateway-state.ts`).
  `ready` is the `/startupz` rule of `lib/agent-readiness.ts` (`probeGateway`): HTTP 200 with
  `status: "started"`. A running agent that is not ready is `starting` for 10 minutes after
  the budget anchor (below), then `not_ready`; a 503 and no answer at all (refused, timeout) both count as not ready. An HTTP answer that is neither (a 200 without `started`, a 404: `probeGateway` answered `unexpected`) is `unknown`. `unknown` also means the exec, the probe or the inspect failed for that
  agent (`probeGateway` answered `error`, which is never cached); the UI treats it like `ready`.
- `blocksOpen` (additive boolean) is true only when the Gateway answered 503, the state is `starting`, `RestartCount` is 0 and the start time is readable: the same cases the Open route refuses. No answer, `unexpected`, `error`, `not_ready` and `stopped` are false. The page disables Open only on `blocksOpen === true`.
- `startedAtMs` is the budget anchor: the first start Rev4a saw for the container id. Docker resets `State.StartedAt` at every restart-policy restart, so a crash loop would otherwise stay `starting`; the anchor stays while `RestartCount` grows and moves to the new `StartedAt` when it drops (or is 0 with a new start time: a manual restart or start). It is cleared when the Gateway is ready, dropped when the container disappears, and kept in memory only: after a Rev4a restart a container with `RestartCount` 0 is anchored again at its `StartedAt` (same clock), while a policy-restarted one starts a new 10 minutes. Known limit: a loop whose Gateway becomes ready for a moment in each run clears the anchor every time, so it never reaches `not_ready`. For `stopped` the field is null; for `ready` it is Docker's `StartedAt`.
- A container Docker lists as `restarting` is not probed (no `docker exec` into it): it counts as running with no answer, so it shows `starting`, then `not_ready` by the anchor, with `blocksOpen` false, instead of `stopped`.
- A stopped container is `stopped` and is never probed. Running containers are probed
  asynchronously (`docker exec` through `execFile`, never a blocking call), at most 4 at a time, 3 s each.
- Cached per container and `StartedAt` (a restart starts over): a `ready` answer for 60 s,
  `starting` and no answer for 2 s; concurrent requests share one probe.
- `{ "agents": {} }` when Docker is unavailable.

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
Create a new agent container from a template. `docker run` is spawned without a shell and the gateway token is handed to docker through its environment (`-e OPENCLAW_GATEWAY_TOKEN`), so it never appears in argv; error messages returned or logged have the token replaced with `***`. The success response still returns `controlToken`.

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
| `memoryLimitMb` | no | Memory limit in MB, an integer from 256 to 1048576 (1 TiB); absent, `null`, `0` or `''` mean no limit and the `docker run` command is exactly what it was. Validated before anything is created (`400` on a bad value); when set, adds `--memory <bytes> --memory-swap <bytes>` (swap equal to the limit) built from the validated integer only |

**A failed create leaves nothing behind.** Once `docker run` has been attempted, any failure (a run error, the Gateway not ready in time, an unexpected error) removes the container and the data volume `agent-<container>-data`, but only when this request created the volume (it is looked up before the run; if it existed or Docker could not say, it is kept). The error message says what was removed ("The agent and its data were removed.") and the removal is logged (`[agent:create] rollback: …`). Cleanup uses immediate force removal, with a 30 s deadline. The Gateway readiness window is 120 s, or 300 s when the image's architecture differs from the Docker host's (`/images/<ref>/json` against `/info`: emulation, several times slower); the timeout error names the window used. The route allows up to 480 s.

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
2. The route waits for the gateway to finish starting (`waitForGatewayReady`, up to 120 s, or 300 s when the image architecture differs from the Docker host's)
3. Once ready, rewrites `openclaw.json` in one write — `gateway.controlUi`,
   `agents.defaults.model` (primary and fallbacks, always as `rev4a/<provider>/<model>`)
   and `update`; the Gateway reloads the file by itself (no restart)
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
volume (`agent-<id>-data`), and **all** its backups (`agent-<id>-*.tar.gz` in `<data>/backups`, and in the legacy
`rev4a-backups` volume while it still exists). This cannot be undone. Volume and backup removal are
best-effort — a missing volume or absent backups do not fail the delete.

The `id` is validated (`isValidAgentId`) before being interpolated into any
docker command.

Deletion uses immediate `docker rm -f` with a 30 s deadline before removing its volume
and backups.

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
on the current build of its OpenClaw version (a newer build if one was downloaded; an image with no version label and no version tag keeps its current image id, the version read inside the container being display-only, and the current image is kept when Docker cannot be read) — **without a backup**: the persistent volume is never
touched (`recreateAgentContainer()` in `lib/agent-recreate.ts`), then the gateway is
waited for (up to 5 minutes) and the runtime config re-applied.

Only Edit (including removal of a memory limit) and Recreate opt into graceful removal
in the shared rebuild. The original inspected container ID is verified against its
`AGENT_ID` label; missing/mismatched IDs are refused. Stop and remove both use that ID,
never a name that could now belong to a replacement. `docker stop -t 60` gives normal
SIGTERM cleanup time to release the owner lease without waiting for OpenClaw's extended
325 s drain. Inspections have 5 s deadlines, stop 65 s, and `rm -f` 15 s: at most 90 s
before rebuilding, within the background caller's budget. A failed/timed-out stop,
Docker exit 137, or an unconfirmed stop records a warning before forced removal.
The job's `error` field retains that warning on success as well as failure; `status`
is authoritative for the outcome. Failed-run cleanup, Update and Rollback retain their
previous force-removal policy.

When the Recreate cold backup already stopped the agent with `docker stop -t 30`,
that is its graceful stop. Recreate observes the backup's stop outcome and persists
exit-137/kill-fallback warnings before archiving; it does not apply another stop policy
to the stopped container. Inspection wall-clock deadlines abort the underlying HTTP
request, including a response that keeps trickling bytes.

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
is taken, naming the holder (display name first): `Port 3700 is already published by Night
Shift (agent_a0000004). Change this agent's port range in the Edit panel, then retry: nothing was
changed.` The row lands in `failed` with that message and the agent keeps running. The
same guard protects Update and Rollback, whose rows record the same text.

**Response (202):**
```json
{ "started": true, "id": 4 }
```

`PATCH` itself does not change the memory limit; removing one is `PUT /api/agents/[id]/memory-limit` with `null`, which starts the same edit job (the container is rebuilt without the memory flags, `memoryLimitRemoved: true` in the edit view).

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
    "memoryLimitRemoved": false,
    "error": null, "startedAtMs": 1790007512520, "finishedAtMs": null
  }
}
```

---

### `POST /api/agents/[id]/restart`
Restart an agent container (shorter than recreate — keeps everything intact). After a successful restart, credential assignments are re-applied in the background once the Gateway is ready.

**Auth:** browser cookie

**Response:**
```json
{ "success": true }
```

**Error (404):** `{ "error": "No container found with AGENT_ID '...'" }`

---

### `GET /api/agents/[id]/backup`
List the agent's backup archives: the plain files in `<data>/backups`, merged by name with the legacy
Docker volume `rev4a-backups` while it still exists (the folder wins). Errors as `502` when the volume
exists but cannot be listed, never as an empty list.

**Auth:** browser cookie or bearer token

**Response:**
```json
{ "backups": [ { "name": "agent-prometheus-2026-07-12_043512345.tar.gz", "size": "227.4 MB", "sizeBytes": 238442455, "date": "12/07/2026 04:35", "epoch": 1752292512 } ] }
```

Archives are created by the cold backup (`POST /api/agents/[id]/cold-backup`) and
excluded the npm package cache (`~/.npm/_cacache/`). Sorted most-recent-first.


---

### `DELETE /api/agents/[id]/backup?file=...`
Remove one backup archive from `<data>/backups` with a plain file call (and from the legacy volume when
it is there too). The name is validated (`agent-<id>-….tar.gz`, no separators or `..`) and joined to the
folder by the server; a file `fs` may not delete falls back to one helper container.

**Auth:** browser cookie

**Response:** `{ "success": true }`

**Error (400):** invalid or path-traversing file name.

**Error (409):** the backups migration is running (`Backups are being moved to the data folder; try again when it ends`); nothing is deleted.

### `POST /api/agents/[id]/cold-backup`
Cold backup of the agent's volume (`lib/cold-backup.ts`). Returns `202` once the job
has started; the work continues in a helper container, `rev4a-backup-<id>`.

1. The agent is stopped (`docker stop -t 30`, 45 s CLI deadline, kill as a fallback)
   if it runs. This policy is unchanged for manual and pre-operation cold backups.
2. The helper, started from the agent's own image, measures the volume (`du`),
   refuses when the backups folder has less free space than about 60% of it, and writes
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

### `POST /api/agents/[id]/restore?file=<archive>`
Start a persisted background restore (`lib/agent-restore.ts`). Returns `202` with
`{ "started": true, "id": <job id> }` after claiming the job; inspect GET for its outcome.
Authentication: browser cookie or bearer token.

1. Validate the name/local regular source and agent busy state. Heavy preflight then runs in the background.
2. Pin the source privately on the backups filesystem and validate archive, config, core SQLite/WAL integrity
   and compatibility with the agent's actual image. Failure leaves the running agent and volume untouched.
3. Take a cold recovery backup using the existing manual cold-backup filename format. Record it before clearing.
4. Extract only the pinned source, start the container and wait for Gateway `/startupz` readiness before `done`.

Unknown targets, corrupt evidence and incompatibility fail preflight explicitly. A versioned archive
must not have a newer config version or exceed the target's core schema ceilings. A metadata-free
legacy archive needs recognized actual core schema generations; a legacy-volume archive waits for
host-directory migration.
A volume-only agent needs a compatible container before restore; the target format is never guessed.
Partial extraction/readiness failure retains the recovery filename, removes the named extraction
helper and verifies the agent stop. A Docker 404 must confirm helper removal before the reservation
or pinned source is released. Cleanup uncertainty keeps status `unresolved` and blocks lifecycle
actions; direct restore failure reports stopped, still running or unknown agent state. Startup
only marks active restores interrupted for review; interrupted extraction becomes unresolved and
names its helper. It makes no Docker cleanup calls and there is no periodic scan over restore
history. Operators confirm `POST /restore/resolve` in Agents > Backups to remove only containers
with that restore's labels. The agent and cold-backup helpers are left untouched. Docker errors
keep the unresolved reservation; a resolve finding no labelled container releases it. Interrupted
jobs require review; startup does not automatically extract or restart possibly changed data.
An abrupt termination can retain a private `.rev4a-restore-source-*` directory for controlled cleanup.

Additional disk space is needed for the pinned compressed source, selected inspection files and cold
recovery archive. Copying reserves the source size plus 1 GiB free; the cold backup has its own space
preflight. Inspection has explicit size/member/time budgets and fails safely when exceeded; these
checks do not guarantee arbitrary workload capacity or native plugin downgrade compatibility.

Errors before admission: `400` invalid name/id; `404` missing local archive; `409` busy/conflicting
operation or unavailable local source. Later failures are recorded on the returned job, without a second POST.

---

### `GET /api/agents/[id]/restore`
The running or last restore of an agent (`null` when it was never restored), with the
archive being applied. `status`: `restoring` → `done` | `failed` | `unresolved`; `interrupted`
after a restart outside extraction, or after confirmed manual resolution. Extraction interrupted
by a restart becomes `unresolved`. Its `finishedAtMs` stays NULL, its pinned source is retained,
and an operator must confirm Resolve restore; there is no automatic retry.

**Auth:** browser cookie or bearer token

```json
{
  "restore": {
    "id": 3, "agentId": "agent_2a3c3a07", "status": "restoring",
    "file": "agent-agent_2a3c3a07-cold-2026-09-21_172032317.tar.gz",
    "error": null, "startedAtMs": 1790004046548, "finishedAtMs": null,
    "phase": "preflight", "recoveryFile": null, "preflight": null
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
version is pulled. Recreate and edit use only image metadata (label or version tag,
including inspection by image id); an image with neither keeps its current image id,
regardless of the version reported inside the container.
An image or version-tag inspection error, timeout, malformed tag array or inconclusive response keeps the
current image id without retagging. Only a confirmed missing version tag permits tagging
the current image. Only a confirmed missing legacy image permits falling back to
`Config.Image` (which may be `:latest`);
without a current image id or that confirmed fallback, the job refuses before
removing the container. Display and update/restore planning may still read the
version inside a legacy container: these answers are cached by Docker container id
and image id (name + image id if no container id is available), for ten minutes on
success or five minutes on failure. Recreating on the same image with a new Docker
container id therefore reads the new container's version.

Flow (each step recorded in `agent_recreates`):
1. **Cold backup** `agent-<id>-prerecreate-<ts>.tar.gz` — the agent stops for it, so
   the archive cannot catch its SQLite files mid-write. **If the backup fails, the
   recreate aborts and the agent is started again.**
2. The container is rebuilt (`lib/agent-recreate.ts`) on the current build of its OpenClaw version (`openclaw-agent-base:<version>`, the pinned build when downloaded; an image with no version label and no version tag keeps its current image id, the version read inside the container being display-only, and the current image is kept when Docker cannot be read), environment
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
    "startedAtMs": 1789524912000, "finishedAtMs": null,
    "laterJob": null, "resolvedAtMs": null, "resolution": null
  },
  "history": [
    { "id": 3, "status": "backing_up", "fromVersion": "2026.9.3", "toVersion": "2026.9.4",
      "error": null, "resolution": null, "resolvedAtMs": null,
      "backupFile": "agent-agent_9253eee3-preupdate-2026.9.3-2026-09-16_003512345.tar.gz",
      "startedAtMs": 1789524912000, "finishedAtMs": null }
  ]
}
```

- `candidate` is `null` when no newer supported version is downloaded.
- `update.status`: `pending` → `backing_up` → `migrating` → `verifying` → `done` |
  `failed`; `interrupted` after a Rev4a restart cut it off; `rolling_back` →
  `rolled_back` | `rollback_failed` for a rollback.
- `update.laterJob`: for a `failed` or `interrupted` update, the agent's latest recreate or latest restore when it
  finished `done` strictly after the update ended (`finished_at`, else `updated_at`), the more recent of the
  two: `{ "kind": "recreate" | "restore", "atMs": … }`; `null` otherwise. A rollback restores the
  pre-update backup, so it undoes that job too; the panel says so. It never blocks the rollback.
- `update.backupAvailable`: `true`/`false` when the pre-update backup file exists, `null` when unknown or not checked. Checked (a short alpine container) only when the panel could offer a rollback, cached 60 s per agent and file; `GET …/update?fresh=1` clears the cache first (the panel passes it when a rollback confirmation opens), and `DELETE /api/agents/[id]/backup` clears it. `false` hides Roll back in the panel; the rollback route still refuses a missing backup (`409`).
- `update.resolvedAtMs` / `update.resolution`: set for a `failed` or `interrupted` update that was later proved
  fine. Only an update that stopped before its own verification qualifies (its `verify_json` is empty and its
  error is a slow-start timeout, or it was interrupted); one with a recorded verification result, a version
  mismatch or any other error never does. The text names the cause ("after a slow start", "after Rev4a
  restarted during the update") and a later recreate or restore. Proof: the container runs, its Gateway is ready, it reports `toVersion` and the stored baseline verification
  passes now (before the resolution is stamped Rev4a re-applies its config and provider block, best-effort; sessions have at least their baseline events, every baseline cron job exists; an unreadable cron
  list is not verified). `status` is not rewritten. Rev4a checks at startup (once per agent, not awaited) and
  in the background when this route is read (at most every 5 minutes per agent); an unresolved failure stays
  as it was. A slow start (the Gateway not ready after 10 minutes) is no longer a failure by itself: the
  update stays `migrating` with a note in `error`, waits up to 30 more minutes (in 30 s waits, each probing the Gateway every 2 s), then finishes the remaining
  steps and becomes `done` (or `failed` if the Gateway never answers or the verification fails).
- `history`: the agent's last 20 updates (newest first) with `id`, `status`, `fromVersion`, `toVersion`,
  `error`, `resolution`, `resolvedAtMs`, `backupFile`, `startedAtMs`, `finishedAtMs`. Read-only; the panel
  offers no rollback from it (only the latest update can be rolled back). The backup is the agent's data from
  before that update: a Restore from the Backup section brings the data back but keeps the OpenClaw version
  (and 2026.9.9 migrates it again), so going back to the previous version is the Roll back of the latest update.
- `verification`: `{ sessions, lostEvents: [{ session, before, after }], missingCronJobs, ok }`.

`503` when Docker cannot be reached.

### `POST /api/agents/[id]/update`
Start an update. **Body (optional):** `{ "version": "2026.9.3" }`; by default the newest
supported version downloaded. Returns `202` with the new `update`; the steps continue in
the background.

1. **Preflight** (refused with `409`): the agent runs, the target is downloaded,
   supported and newer than the agent's version, no update or backup is running.
2. **`pending` / baseline**: wait up to 5 minutes for the existing Gateway's `/startupz`
   to report `started`, then confirm the container is still running. The panel shows
   "Waiting for the agent to finish starting…"; the Update button's availability is unchanged.
   If startup times out or the container has stopped, the row fails with guidance to wait
   until the agent is ready and try again; nothing was stopped or backed up. Read the cron
   list only after readiness; if unreadable, retry once after 5 seconds, then fail with
   the existing unreadable-list message before any backup or stop. Record transcript events
   per session (`transcript_events`
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

A failure between the cold backup stopping the old container and the recreate restarting it
starts the old container again. A failure after the recreate leaves the agent on the new
version; the panel offers Rollback.

**Errors:** `400` unsupported version, `409` refused (reason in `error`), `500`.

While an update runs, `backup`, `cold-backup`, `restore`, `recreate`, `lifecycle`,
`PATCH` and `DELETE /api/agents/[id]` answer `409 "An update of this agent is running"`,
and the provider sync skips the agent.

### `POST /api/agents/[id]/update/rollback`
Roll back the latest update — `done`, `failed`, `interrupted` or `rollback_failed` — while
its pre-update backup exists. `202` with the `update` (`rolling_back`). A failed or interrupted update that was
resolved (`resolvedAtMs` set) is still accepted: the panel offers it as "Roll back anyway…" and asks for the agent's
name to be typed; the route itself does not ask. Starting a rollback clears `resolved_at` and `resolution`, so an
interrupted rollback is red again with Roll back.

1. The previous version's image is made local (pulled only when its version tag is
   confirmed missing and the version is supported). An inconclusive lookup fails the
   job with `Could not check the local image for <version>; try again.` before any
   pull, retag, stop or volume restore.
2. The agent is stopped and its volume replaced by the pre-update backup.
3. The container is recreated on `openclaw-agent-base:<from>` and must report that version.

The restored `openclaw.json` stays in place; credential assignments are re-applied in the background after the previous version starts and its Gateway is ready. Everything the agent did after the backup is lost. `409` when there is nothing
to roll back, the backup is gone, or an update or backup is running.

---

### `POST /api/agents/[id]/lifecycle`
Start, stop or restart an agent container.

**Auth:** browser cookie or bearer token

**Body:** `{ "action": "start" | "stop" | "restart" }`

Redundant actions are no-ops: starting a running container, or stopping a stopped
one, succeeds without touching it.
After an actual start or restart, credential assignments are re-applied in the background once the Gateway is ready.

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
through the same state transaction the CLI uses. On a release that no longer exposes the writer the call
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

Optional `job=<id>` selects `/automations?job=<id>` under the existing native base path. The
existing query and authentication fragment are preserved. Invalid, empty or repeated job parameters
return 400 before container discovery or native link issuance. Callers cannot supply a target host.
Without `job`, the existing root navigation is unchanged.

The target host is derived from the `Host` header, with the agent's published port;
callers cannot choose it through a parameter. To keep dashboard cookies away from
agent ports, `localhost` (case-insensitive, including `localhost.`) maps to `127.0.0.1`;
`::1`, `[::1]` and any `127.x.y.z` map to `localhost`, which resolves to both loopback
address families so IPv6-only publishes remain reachable. Other hosts, including
LAN/public IPs, domains and `localhost.example.com`, stay unchanged. Both link kinds
use this mapping, including the one-time link's `gatewayUrl` fragment. Paths, query
parameters and authentication fragment values are preserved.

When the host cannot be isolated, the request URL uses `http:` and
`REV4A_FORCE_INSECURE_COOKIE=1`, the route logs once per process:
`[control-ui] dashboard on plain HTTP: the session cookie is visible to agent ports; use HTTPS`.
It adds nothing to the redirect. The client-address helper has no trusted proxy
protocol support, so the request URL's protocol is used. Next.js derives it from
`X-Forwarded-Proto` when present, so a client can suppress this warning; it is only a log
hint, the isolation above does not depend on it.

- Runs `openclaw dashboard --json` in the container and redirects to its `browserUrl`,
  with the host, the port and the `gatewayUrl` fragment parameter rewritten to that host
  and the published port. The link is single-use, expires after ten minutes, and pairs
  the browser with no approval.
- When no one-time link can be issued: redirects to the plain link
  `http://<host>:<port>/#token=<token>`, with the token read inside the container
  (`/root/.agent-token`, then `OPENCLAW_GATEWAY_TOKEN`).

**Upgrade note (SEC-16):** a browser previously paired on `localhost:<port>` now opens
on `127.0.0.1:<port>`. The one-time link pairs it again without approval; a plain token
link may require pairing approval once. No database, configuration or volume migration
is needed, and older agents retain the plain token fallback.

Before resolving the link the route runs one readiness probe (`probeGateway`, 3 s). Only a Gateway that
answers 503 on `/startupz` inside 10 minutes of the container's `StartedAt` gets a `503` page
instead of a redirect to a dead port. `ready`, `not_ready`, no answer or a timeout, an unexpected answer, a failed probe, an
unreadable `StartedAt` and a container with `RestartCount > 0` (restarted by its policy, not a fresh start) resolve the link as usual.

A navigation, not a JSON call: the button opens this URL inside the click, so no tab
is left blank after an `await` and no popup can be blocked.

**Errors** (plain text, meant for the tab): `400` host not readable, `404` unknown agent,
`409` agent not running or no published Control UI port, `503` Docker unreachable or the
agent's Gateway still starting ("The agent's Gateway is still starting. Try again in a moment."),
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
Read `openclaw.json` from a running agent container with secrets masked server-side.
Useful for inspecting the container config without SSH or terminal.

`redactConfigSecrets()` in `lib/redact-secret.ts` recursively replaces secret-named
values with `***`, sharing the key classifier used by update-log redaction
(`isSecretName()` in `lib/update-state.js`). This covers Gateway and Telegram tokens,
provider API keys, passwords, private keys and unknown secret-named keys, including
short and non-string values. Context also masks channel bot/account tokens and secrets,
serialized channel service accounts, `authTag` and other auth-named keys, all `headers`
values anywhere (including nested provider requests and plugin configuration), TLS
`ca`/`cert` values including proxy TLS, every value in an `env` object anywhere (including plugin
MCP configuration), skill `apiKey`, credentials and auth-profile material. Primitive
array members inside private locations are masked too. Non-secret structure, model
lists, channel settings and `gateway.auth.mode`/`allowTailscale` remain visible; other
`gateway.auth` material is masked. No source file is modified. Malformed JSON and any
non-object root (including arrays, strings and null) return 500 without raw content;
transport errors return a generic message without stdout/stderr.

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
**Error (500):** `{ "error": "Failed to parse config JSON" }`,
`{ "error": "Config JSON must be an object" }` or
`{ "error": "Could not read the agent config" }`.

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
- Writes the new token to `data/agents-token.json` (mode 0600, also on a file written by an older release)
- Saves and agent creates are serialized by one process-wide lock (`lib/agent-token-lock.ts`): two saves end with the file and every container on the last token, and a save during a create waits for the new container to exist
- If Docker cannot be reached the file is still written and the answer is `502 { success: false, error: "Docker is not reachable: …" }`; when some containers failed, `success` is `false` and `error` summarizes them (the page shows it)
- Writes the token file (`/root/.agent-token`, mode 0600, replaced atomically) into every running container with `AGENT_ID` label. The token is sent on stdin to a constant script, so the write never puts it in host or container argv (the gateway process itself receives it in `OPENCLAW_GATEWAY_TOKEN` from the image entrypoint, `agent-templates/base-image/entrypoint.sh`, not as `--token`; images built before SEC-13 and agents whose `openclaw.json` sets `gateway.auth` still use `--token`); every `error` returned (per container and the outer one) has the token replaced with `***`
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
      "storage": { "volume_mb": 1544, "layer_mb": 10, "total_mb": 1554, "ts": 1790789645 },
      "is_backup": false }
  ],
  "rest": { "cpu_percent": 42.26, "mem_mb": 11864 },
  "docker_storage": { "ts": 1790789645, "images_mb": 4734, "images_reclaimable_mb": 3518,
                      "build_cache_mb": 1597, "build_cache_reclaimable_mb": 1597,
                      "volumes_mb": 10120, "unused_volumes_mb": 7337, "layers_mb": 30,
                      "unused_volumes": [ { "name": "agent-atlas-data", "size_mb": 7337 } ] }
}
```

- `is_backup` is true for a cold-backup helper (`rev4a-backup-<agentId>`, see `lib/cold-backup.ts`);
  its `name` reads "Backup of <agent name> (manual | before update | before recreate)" while it runs.
  A helper is listed only while it runs: `running`, or seen by Docker on the latest passes without a sample yet
  (its first pass, or a stats call that fails); once it is neither, it is left out of `containers` whatever the
  range. The read side recognises a helper by its container name alone (`lib/backup-helper.js`), so a container of
  your own named `rev4a-backup-…` is treated the same way. Its rows stay in `metrics.db` until the daemon prunes them. It is
  never an agent (`is_agent` false, `agent_id` null).
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

### `GET /api/agents/[id]/packages`
The apt packages an agent recorded and the outcome of its last restore, read with argv `docker exec` (`cat`, 5 s timeout each, 1 MB cap) from `/root/.rev4a/packages.txt` and `/root/.rev4a/packages-status.json`. Read-only.

**Auth:** browser cookie or Bearer `REV4A_TOKEN`

```json
{ "supported": true, "running": true,
  "status": { "at": 1791648030000, "state": "partial", "restored": ["jq"], "versionChanged": [], "failed": [{ "name": "postgresql-client-17", "error": "E: Unable to locate package" }] },
  "packages": [{ "name": "jq", "version": "1.7.1-3" }] }
```
`supported` is false when the image has no `/usr/local/sbin/rev4a-apt` (an agent that predates the recorder); `running` is false for a stopped container (nothing is read, `status` null, `packages` empty). A paused or restarting container answers `running: true` with `transient: "paused"` or `"restarting"` (nothing is read). `supported` is false only when `test -x` exits 1; any other failure of the read (timeout, Docker error) answers `error: "Could not read the agent's packages"` with the other fields empty. `status` is null when the file is missing or unreadable; a failed entry named `*` is the restore script reporting that the run itself timed out or exited unexpectedly; `state` is one of `running`, `ok`, `partial`, `failed`, `nothing-to-do`. The contents come from inside the container: names and errors are cut at 200 characters, lists at 500 (status) and 2000 (packages). **Errors:** `400` invalid id; `404` no container carries the id.

### `GET /api/agents/[id]/memory-limit`
The agent's memory limit, read from the container inspect.

**Auth:** browser cookie or Bearer `REV4A_TOKEN`

```json
{ "limitMb": 2048, "swapMb": 2048, "running": true, "usageMb": 896, "dockerTotalMb": 7940 }
```
`limitMb` is `null` when there is no limit; `swapMb` is memory plus swap (`-1` for unlimited swap, `null` for none). `usageMb` is the working-set memory from the Docker stats API (one-shot read when the request arrives; `null` when the container is stopped or the read failed); `dockerTotalMb` is `/info` `MemTotal` (the VM on macOS, the host on Linux). `404` when no container carries the id.

### `PUT /api/agents/[id]/memory-limit`
`{ "limitMb": 2048 }` sets the limit **live** with `docker update --memory <b> --memory-swap <b>` (both flags together, swap equal; no restart; it also works on a stopped container) and answers `200` with the new GET body. If the re-read after the update fails or times out, the answer carries the applied value (`limitMb`, usage and total `null`), never the old one. While the update runs the agent is claimed: an edit, recreate, update or restore that starts meanwhile answers `409`.

`{ "limitMb": null }` removes it. `docker update` cannot (0 means "unchanged"), so an edit job (`startAgentEdit` with `removeMemoryLimit`) rebuilds the container without the flags — no backup, the data volume is kept — and the answer is `202 { "started": true, "id": 4 }`, followed through `GET /api/agents/[id]` like any edit. Answers `200` with the current body when there is nothing to remove. The edit is recorded in `agent_edits.memory_limit_removed`.

**Auth:** browser cookie or Bearer `REV4A_TOKEN`. **Errors:** `400` invalid id, missing `limitMb`, or a value outside 256–1048576 MB or not a whole number (`0`, `''` and `"0"` included: only a literal JSON `null` removes the limit); `404` no container; `409` another long operation (update, recreate, restore, edit, backup) is running on the agent.

### `GET /api/agent-defaults` / `PUT /api/agent-defaults`
`{ "memoryLimitMb": 2048 }`, or `null`: the default memory limit that **prefills** the create wizard. It never applies to an existing agent. `PUT` validates like the create route (`400` on a bad value; `null`, `0` or `''` clear it). Stored in `agent-defaults.json` (see DATABASE.md). **Auth:** browser cookie or Bearer `REV4A_TOKEN`.

### `GET /api/settings` / `PUT /api/settings`
`{ "timezone": "Europe/Rome", "source": "saved" }`: the time zone every dashboard page shows times in. `source` is `"saved"` when one was saved; otherwise `"env"` when `REV4A_TIMEZONE` holds a valid zone, else `"server"` (the server's own zone, `"UTC"` if it cannot tell). `PUT { "timezone": "Europe/Rome" }` accepts only an IANA name the runtime knows (the `Intl.supportedValuesOf("timeZone")` list, `UTC`, or an alias it resolves, such as `Asia/Kolkata`); anything else is `400`. The name is stored and returned in canonical spelling (`europe/rome` becomes `Europe/Rome`, `utc` becomes `UTC`). `PUT { "timezone": null }` forgets the saved zone and answers with the default now in effect. Stored in `settings.json` (see DATABASE.md). **Auth:** browser cookie or Bearer `REV4A_TOKEN`.

### `GET /api/metrics/alerts?limit=10&metric=&container=&agent=`
The latest `system_anomaly` events: the machine (CPU above 85 % or memory above 90 % on two
samples in a row, a disk at 90 %) and the containers (`container_pids`: 1 000 processes on two
samples in a row; `container_memory`: 90 % of Docker's memory on five; `container_oom`: a process was killed for lack of memory, at most one alert per container per 10 minutes; `packages_failed`: an agent could not reinstall some of its recorded apt packages after a start, `container` field set, `values` the failed package names), newest first, from `events.db`. `limit` 1–50, default 10. Optional `container=<name>` keeps only the events written with that `container` field (today the `container_oom` and `packages_failed` ones); unknown params are ignored. Optional `metric=<name>` keeps only the events of that metric (exact match; it must match `^[a-z_.]{1,64}$`, `400` `Invalid metric` otherwise) and the limit then counts matches only, so a frequent metric cannot crowd a rare one such as `container_oom` out of a short list; without it the behaviour is unchanged.

**Auth:** browser cookie or Bearer

**Response:**
```json
{ "alerts": [ { "ts": 1790789625355, "metric": "disk", "message": "Disk high: / 94% used", "threshold": 90, "values": [94],
               "container": null, "scope": null, "agent": null, "resolved": false, "snoozedUntil": null,
               "agentName": null, "displayMessage": "Disk high: / 94% used" } ] }
```
Every alert carries `container`, `scope`, `agent`, `resolved` and `snoozedUntil` (`null`, or `false` for `resolved`, when not set).
`ts` is in **milliseconds** (the `events` table's unit); `metric` is `cpu`, `ram`, `disk`, `container_pids`, `container_memory`, `container_oom`, `packages_failed`, `spend.session`, `spend.loop`, `spend.unusual`, `spend.unaccounted` or `null`. Each alert also carries two fields added at read time (stored rows are never rewritten, so older rows get them too): `agentName`, the agent's display name (`AGENT_NAME`) when the alert's `container`, or the one container named in the message, is known, else `null`; and `displayMessage`, `message` with each known `agent_<8 hex>` container name rewritten to `Name (container)`. The page shows `displayMessage`. Spend alarms (`spend.session`, `spend.loop`, `spend.unusual`, `spend.unaccounted`; see REV4A.md, Spend and loop alarms) also carry `agent` (the agent id the proxy saw, or the container for a session), `scope` (`vendor:<name>` for the balance alarm), `resolved` (`true` for the "back to normal" note; `spend.unaccounted` has none) and `snoozedUntil` (ms, from the server, `null` when not snoozed). Optional `agent=<id>` joins `container=` (either name keeps an event); the `container` filter also matches a spend alarm whose `agent` is that name. `container` is the container name for `container_oom` events and `null` for the others; for `container_oom`, `values` is `[limit in MB]` (empty when the agent has no limit or it could not be read).

---

## System volumes

### `GET /api/system/orphan-volumes`
Docker volumes named `agent-*-data` that no container uses, in any state (also a volume Rev4a did not make, which is why Delete asks for confirmation) (read from `GET /containers/json?all=1` on every call). Never lists `rev4a-*` or any other volume. A volume whose agent is busy (recreate, update, restore, edit, backup; `agentBusyReason`) is left out; one whose agent's latest recreate is not `done`, or latest update is not `done`/`rolled_back` (or resolved), is listed with `keptReason` and no Delete (an **edit** that failed or was interrupted keeps its volume the same way).

**Auth:** browser cookie or bearer token

**Response:** `{ "volumes": [{ "name": "agent-agent_1a2b3c4d-data", "sizeBytes": 597688320, "createdAt": "2026-10-22T09:12:00Z" }] }`, newest first. `sizeBytes` is `null` when Docker has not measured it. Sizes and creation times come from `GET /system/df` (the one call that measures volumes, on Docker Desktop and Linux alike; it can take seconds on a big host), cached for 5 minutes (`type=volume`), and the cache is dropped after a delete. `502` when Docker cannot be read (every Docker read has a 10 s timeout; concurrent reads share one request).

### `DELETE /api/system/orphan-volumes/<name>`
Remove one volume. The name must match `agent-<name>-data` (`400` otherwise), the containers are read again (`409` if one, even stopped, mounts it), the volume must exist (`GET /volumes/<name>`, `404`), the agent must not be busy and its last recreate/update must have finished (`409`, checked last, right before the removal), and `docker volume rm` runs without `-f`. Nothing deletes an orphan by itself; this runs on a click in the System page. Response `{ "success": true }`; the removal is logged. `500` with the error text when Docker fails to remove it.

## Backups migration

### `GET /api/system/backups-migration`
State of the move of backups from the legacy Docker volume `rev4a-backups` to `<data>/backups` (started at
every Rev4a start, in the background; see ARCHITECTURE).

**Auth:** browser cookie or bearer token

**Response:**
```json
{ "status": "pending", "reason": null, "moved": 0, "remaining": 0, "current": null, "skipped": [] }
```
`volumeRemoved` (optional, additive) is `true` once the legacy volume is known to be gone; only then do backup listing, reading and deleting skip asking Docker, so they keep working with Docker down.
`skipped` lists `{ name, reason }` of files whose copy did not verify: they stay in the volume while the other files
are still moved (the run then ends `stopped` with those names in `reason`).
`status` is `pending` (not started, or the volume still exists), `running`, `done` (nothing left to move: the volume is removed, or kept because a container still uses it or it holds other files) or
`stopped` with a `reason` (not enough free space (the file plus 1 GiB of headroom, the data folder can be on another filesystem than Docker), a copy that did not verify, Docker not answering, files
of a busy agent, files that exist in both places with different sizes, a leftover temporary copy in the backups folder that could not be removed). `*.partial` leftovers of older releases are deleted from the volume so it can empty.
While it is `running`, `DELETE /api/agents/[id]/backup?file=` answers `409` (`Backups are being moved to the data folder; try again when it ends`) and deletes nothing, and the automatic pruning of old backups skips and catches up at the next run (a file removed mid-copy would otherwise be copied back). Deleting an agent still removes its backups; in the rare case it runs while a copy of one of its files is in flight, that file can reappear in the folder and is listed there. A stopped migration resumes at the next start (after `Docker did not answer` it also retries by itself every 5 minutes); nothing is deleted before a verified copy.
The System page shows a one-line notice while it is not `done`.

---

## System Health

### `GET /api/system-health`
Aggregated checks of the runtime, cron jobs and usage cost, with recommendations. It
does not report CPU, RAM or disk (those are in `GET /api/metrics`). Its `runtime.heartbeat`
check ("Daemon heartbeat") reads the age of the newest machine metrics sample in
`metrics.db`: it shows the daemon is alive, not that the session collector ingests —
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
`type` is `fail`, `spawn_timeout` (the two types older installs hold, from the previous host poll) or
`session_failed` (the session collector); it also counts failed cron runs and failed sessions; the
`events.ts` column is in milliseconds and any count above zero is a warning that raises the
`runtime.review-errors` recommendation),
`cost.usageBasedToday` ("Spent today": the agents' spend today, UTC day, from `costs.db`;
a warning above $10 or with calls without a price, each with its recommendation,
`cost.review-usage-based` / `cost.unpriced-calls`), `cron.jobs`. `health` (overall and per check) is `"ok"` /
`"warning"` / `"error"`; a recommendation's `severity` is `"info"` / `"warning"` /
`"critical"`. `generatedAt` and `createdAt` are ISO strings.

---

## Crons

### `GET /api/crons`
List of scheduled cron jobs from every running Docker container with the `AGENT_ID` label (via `docker exec openclaw cron list --json`). There is no host source: Rev4a never calls an `openclaw` binary on the host.

Every job includes `containerName` and `source: "container"` fields, plus `agentName`: the agent's display name (the container's `AGENT_NAME`), or `null` when the agent has none. The page labels tabs, pills and the detail by `agentName` and shows `containerName` only as a secondary detail. The names come from `lib/agent-names.ts` (one cached `docker inspect` for all containers).

`rev4aAgentId` is the trusted Docker `AGENT_ID` from discovery, used for Rev4a navigation. It is
separate from OpenClaw's internal `agentId` (often `main`); an upstream field cannot override it.
Older consumers can ignore the additive field. The Crons view recognizes the exact latest-run
missing-inference-account refusal and provides native settings/account-reference guidance.

**Auth:** Bearer or browser cookie

**Query params:** `status=1` (optional) answers `{ "jobs": [...], "dockerUnavailable": false, "errors": [{ "container", "agentName", "error" }] }` instead of the bare array, so a caller can tell an empty list from "Docker is not reachable" (`dockerUnavailable: true`) or an agent that did not answer (one entry in `errors`). The Crons page uses it and shows a banner. `GET /api/system-health` raises no "No enabled cron detected" in either case.

**Response:**
```json
[
  {
    "id": "c1b3e47f-...",
    "name": "atlas-weekly-report",
    "schedule": "0 9 * * 1",
    "enabled": true,
    "source": "container",
    "agentId": "main",
    "rev4aAgentId": "atlas",
    "containerName": "openclaw-atlas",
    "agentName": "Atlas",
    "computedNextRunAtMs": 1749600000000
  }
]
```

### `PATCH /api/crons/[id]`
Update a cron job. Only the `enabled` field can be patched.

`containerName` is required and must be one of the agent containers Docker lists; the job id must match `^[A-Za-z0-9_][A-Za-z0-9_-]{0,127}$`. Otherwise the call fails with 400 (`Invalid job id` or `Unknown agent`), before anything is executed in a container; 502 `Docker is not reachable` when the container list cannot be read. The same checks apply to `DELETE /api/crons/[id]` and `GET /api/crons/runs`.

**Auth:** Bearer or browser cookie

**Body:**
```json
{
  "enabled": false,
  "containerName": "openclaw-atlas"
}
```

**Response:**
```json
{
  "id": "c1b3e47f-...",
  "enabled": false
}
```

### `DELETE /api/crons/[id]`
Remove a cron job permanently from its agent container. `containerName` is required as a query parameter; without a valid one the call fails with 400.

**Auth:** Bearer or browser cookie

**Query params:**
- `containerName` (required) — Docker container name of the agent that owns the job

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
The Context page. Read-only; no file contents are ever returned.

**Auth:** browser cookie

Without `agent`: the agent containers for the selector, `{ "agents": [{ "container", "label", "running" }], "dockerAvailable": true }` (`dockerAvailable: false` and an empty list when Docker cannot answer).

With `?agent=<container>`: one read inside that container (a constant `node -e` script, argv only). The answer is cached 30 s per agent; `fresh=1` skips the cache.

**Response:**
```json
{
  "agent": "agent_8ba21f83",
  "files": [
    { "name": "SOUL.md", "path": "SOUL.md", "exists": true, "chars": 25000, "injected": 20000, "truncated": true },
    { "name": "MEMORY.md", "path": "MEMORY.md", "exists": true, "chars": 1200, "injected": 1200, "truncated": false,
      "optional": true, "note": "Only when present; left out in sub-agent, cron, group and channel sessions" }
  ],
  "totals": { "injected": 21200, "cap": 60000, "chars": 26200, "truncatedFiles": 1, "linkedFiles": 0 },
  "other": [{ "name": "TOOLS.md", "path": "TOOLS.md", "chars": 800 }],
  "limits": { "perFile": { "value": 20000, "source": "default" }, "total": { "value": 60000, "source": "config" } },
  "memory": { "linked": false, "files": [{ "name": "dreaming/2026-10-20.md", "path": "memory/dreaming/2026-10-20.md", "size": 3100, "mtimeMs": 1792500000000 }], "truncated": false },
  "rules": { "path": ".rev4a/AGENTS.md", "exists": true, "size": 900, "linked": false }
}
```
`files` lists the injected files in injection order (AGENTS, SOUL, IDENTITY, USER, BOOTSTRAP, MEMORY); `other` lists TOOLS.md and HEARTBEAT.md when present (not injected, not counted); `chars` is null for a missing file or a symlink (never followed: such a file has `linked: true`, its `injected` is unknown and counted in `totals.linkedFiles`, and the total leaves it out). A whitespace-only file injects 0. A linked file reports `injected: 0` in the JSON (the page shows "unknown" for it). A prompt file larger than 8 MB is not read: `chars` then holds its size in bytes. A symlinked `memory/` or `.rev4a` folder is not read (`memory.linked`, `rules.linked`). `injected` applies the per-file cap, then the total cap: the file that crosses the total cap is cut to the characters that remain, later files get 0. `limits` come from the agent's `openclaw.json` (`agents.entries.<id>` over `agents.defaults`, keys `bootstrapMaxChars` and `bootstrapTotalMaxChars`) or the OpenClaw defaults (`source`: `config` or `default`). `memory.files` are the newest 200 files under `memory/` by mtime (walked to depth 3, at most 20000 entries visited); `memory.truncated` is true when more exist, the walk was cut or folders lie deeper. Sub-agent sessions only inject AGENTS.md (OpenClaw system-prompt docs). `agents.entries.main` is the entry id on real agents.

The figures are approximate for agents on the native Codex harness: there OpenClaw routes SOUL.md, IDENTITY.md and USER.md differently and does not paste MEMORY.md on every turn.

**Errors:** 400 invalid or unknown agent; 500 `Could not read the context` (an unexpected failure); 502 agent not running, no answer in time or unreadable output; 503 Docker not available.

---

## Workspace

Full design, decisions, and usage guide at [WORKSPACE.md](WORKSPACE.md).

### `GET /api/workspace?action=list`
List the agent workspaces: every Docker container with an `AGENT_ID` label, running or stopped. There is no host workspace.

**Auth:** Bearer token or the `rev4a_token` browser cookie

**Response:**
```json
{
  "workspaces": [
    { "id": "container-agent_8ba21f83", "label": "Giuanmuzzziins", "type": "container",
      "path": "/root/.openclaw/workspace/", "containerName": "agent_8ba21f83", "running": true,
      "readOnlyPaths": ["/root/.openclaw/workspace/.rev4a"] }
  ],
  "dockerAvailable": true
}
```
`readOnlyPaths` lists the read-only mounts inside the workspace root (`[]` when none or when the inspect fails).
When Docker is not available the answer is still 200: `{ "workspaces": [], "dockerAvailable": false }`.

### `GET /api/workspace?workspace=<id>`
List files in a workspace, read a file, or return a recursive tree payload.

**Auth:** any auth method

**Query params:** `workspace` (optional, defaults to the first running agent, else the first agent in the list; `400 No agent workspace available` when there is none), `path` (optional, inside `/root/.openclaw/workspace`), `tree=1`, `list=1`, `hidden=1`, `stat=1` (optional)

**Response (directory):** folders first, then by name.
```json
{
  "workspace": "container-agent_8ba21f83",
  "label": "Giuanmuzzziins",
  "path": "/root/.openclaw/workspace",
  "type": "container",
  "files": [
    { "name": "skills", "isDirectory": true, "isFile": false },
    { "name": "SOUL.md", "isDirectory": false, "isFile": true }
  ]
}
```

**Response (file):** same structure with `content` (the exact text, UTF-8, nothing trimmed) instead of `files`, plus `size` and `mtimeMs` (whole seconds, as milliseconds). `tail`, `offset`/`length`, `info=1` and `download=1` are described next.

**Additions (WS-3).** All are additive; every existing field and status is unchanged.

- `stat` now reports the mtime too (`stat -c '%F|%s|%Y'`): whole seconds, so every `mtimeMs` below is a multiple of 1000. The text read response (`&path=<file>`) adds `size` and `mtimeMs` (taken from the stat just before the read, so a file that changes during the read shows up as a conflict, never as a false match).
- **Tail:** `&path=<file>&tail=<bytes>` (empty value: 262144; 1 to 2097152) returns the last bytes. **Range:** `&offset=<n>&length=<m>` (`length` 1 to 2097152). Either answers `200 { workspace, label, path, type, content, size, mtimeMs, offset, length, truncated }` for any text file whatever its size (no 413 in these modes). The window is cut on UTF-8 boundaries: a partial character at the start (when `offset` > 0) and at the end (when the window stops before the end of the file) is dropped, and `offset`/`length` are the byte position and size of what is really returned; `truncated` is true when that is not the whole file. Invalid UTF-8 inside the window answers 415; a partial character at the very end of the file counts as invalid. Bad numbers, or `tail` together with `offset`/`length`, answer 400.
- **Info:** `&path=<file>&info=1` answers `200 { path, size, mtimeMs, kind: "text" | "binary" | "empty", label? }` from the first 4 KiB: a NUL or invalid UTF-8 is `binary`; `label` names a format from its magic number (SQLite database, ZIP archive, ZIP (Office document) for docx/xlsx/pptx by extension, gzip archive, tar archive, PDF document, PNG, JPEG, GIF and WebP image, ELF executable, WebAssembly module, MP4 video, MP3 audio) and is left out for anything else. A directory or special file is 400.
- **Download:** `&path=<file>&download=1` answers the exact bytes of any regular file up to 50 MiB with `Content-Type: application/octet-stream`, `Content-Disposition: attachment; filename*=UTF-8''<encoded basename>`, `Content-Length`, `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Same confinement, large-read limiter (503) and statuses as raw mode; 413 over 50 MiB. No extension check.
- **Read-only roots:** `action=list` adds `readOnlyPaths: string[]` to each workspace (read-only bind mounts inside the workspace root, from `docker inspect`, e.g. `/root/.openclaw/workspace/.rev4a`; `[]` when the inspect fails), and the `tree=1` entries inside one carry `readOnly: true` (the key is absent elsewhere).
- **Save conflict:** `PUT` accepts an optional `expectedMtimeMs` (the `mtimeMs` from the read). When the file exists and its mtime (whole seconds) differs, nothing is written and the answer is `409 { error: "The file changed on the agent since you opened it", mtimeMs }`. When the file no longer exists, nothing is written either and the answer is `409 { error: "The file was deleted on the agent since you opened it", deleted: true }`. The comparison runs inside the container's write script, before anything is created (a refused save makes no folder) and again as the last step before the rename, so the only window left is a change in the same second as the one the page saw (a precision of one second). Without `expectedMtimeMs` a save is exactly as before. A successful `PUT` answers `{ ok: true, mtimeMs }`, the mtime printed by the write script itself after the rename; if that is missing, the answer is `{ ok: true }` only and the page says the conflict check is off until the file is reopened.

**Additions (WS-5).** Both are additive; `tree=1` and every existing field and status are unchanged. The Workspace page no longer uses `tree=1`.

- **Folder listing:** `&list=1[&path=<dir>][&hidden=1]` answers `200 { workspace, label, path, type, entries, truncated }` for ONE level of a folder (the root when `path` is left out). `entries` are `{ name, path, relPath, type: "file" | "directory", size, mtimeMs, isDirectory, isFile, readOnly? }` (`relPath` is relative to the workspace root; `size` is 0 for a folder; `readOnly: true` only inside a read-only mount), folders first, then by name (the tree's comparator). Dot-entries are left out of every folder, not only the root, unless `hidden=1` (so a nested `.env` needs "Show hidden files"), except the root of a read-only mount (`.rev4a`), which is always listed. `node_modules`, `.git` and the like are listed as folders. At most 5,000 entries (cut after sorting, so folders come first); `truncated` is `true` when there were more. The folder goes through the same confinement as every path (400 / 403); a missing folder is 404 and a file is 400 `That path is not a directory`. The listing is one constant `find` (`-mindepth 1 -maxdepth 1 -printf '%y|%s|%T@|%f\0'`) with the folder as an argument.
- **Stat:** `&path=<file>&stat=1` answers `200 { path, size, mtimeMs, kind: "file" | "directory" | "other" }` from one `stat`, with no content read. The page polls it every 10 s to notice a file the agent changed.

**Errors** are always `{ "error": "..." }` with a real status: `400` unknown workspace id or bad path ·
`403` path outside the workspace root (after `..` and symlinks) · `404` file not found ·
`409` save conflict (PUT with `expectedMtimeMs`) · `413` file over 2 MiB (`File too large to open here (<size>, limit 2 MB)`; not for tail, range, info or download) ·
`415` not valid UTF-8 (`Not a UTF-8 text file: it cannot be opened or edited here`; the bytes are read exactly, as base64) ·
`502` the agent is not running (`Agent <label> is not running`) or did not answer in time · `503` Docker not available. Also: `400 Use tail, or offset with length, not both`, `400 expectedMtimeMs must be a number` (PUT), `415 No preview for this file type` (raw mode, checked before the file is looked up) and `502 Could not check whether the location is writable` (PUT, when `docker inspect` of the container fails).

### `GET /api/workspace?workspace=<id>&path=<file>&raw=1`
Raw mode: the exact bytes of a file the browser can show with its own viewer or player (the Workspace page opens images, SVG, PDF, audio and video this way). Read-only; nothing here edits or saves.

**Auth:** any auth method (the page's cookie also works for `<img>` and `<iframe>`).

**Response:** `200` with the file's bytes and these headers: `Content-Type` from the extension map below (unknown: `application/octet-stream`), `Content-Length`, `X-Content-Type-Options: nosniff`, `Content-Disposition: inline; filename*=UTF-8''<encoded basename>`, `Cache-Control: no-store`, and for SVG also `Content-Security-Policy: sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline'`.

**Served types (lowercase extension):** png `image/png` · jpg, jpeg `image/jpeg` · gif `image/gif` · webp `image/webp` · avif `image/avif` · bmp `image/bmp` · ico `image/x-icon` · svg `image/svg+xml` · pdf `application/pdf` · mp3 `audio/mpeg` · wav `audio/wav` · ogg, oga `audio/ogg` · m4a `audio/mp4` · flac `audio/flac` · aac `audio/aac` · mp4, m4v `video/mp4` · webm `video/webm` · mov `video/quicktime` · ogv `video/ogg`. Any other extension answers `415` `No preview for this file type` (checked on the requested path and on the path after symlinks), so the mode cannot pull arbitrary files such as `.env`.

**Errors** are JSON `{ "error": "..." }`, as above: `400` bad id or path, or the path is a directory or not a regular file · `403` outside the workspace root · `404` not found · `413` over 50 MiB (`File too large to open here (<size>, limit 50 MB)`) · `415` type not served · `502` the agent is not running, did not answer in time, or the file changed while it was read · `503` Docker not available, or two files over 8 MiB are already being opened (`Another large file is being opened: try again in a moment`; a large read holds about 3.3x the file in memory). There is no Range support.

### `PUT /api/workspace`
Write content to a workspace file. Exactly `content` is written (no newline added), atomically, with the file's mode kept.

**Auth:** any auth method

**Body:** `{ "workspace": "container-agent_8ba21f83", "path": "/root/.openclaw/workspace/test.md", "content": "hello" }`

**Optional field:** `expectedMtimeMs` (see the save conflict above).

**Response:** `{ "ok": true, "mtimeMs": 1750000000000 }`

**Errors:** as above, plus `409` (`expectedMtimeMs` given and the file changed, or was deleted: then `deleted: true`; nothing is written), `423` when the target is in a read-only mount (the Rev4a rules at `/root/.openclaw/workspace/.rev4a`)
and `400` when the body is not valid JSON, `workspace`, `path` or `content` is not a string, or the path is a directory.

---

## Provider keys and credentials

Provider API keys are read with `GET /api/gateway/provider` and set with
`POST /api/gateway/provider` — documented in `docs/dev/PROVIDERS.md`, which is the
only file carrying that endpoint's request bodies. `PUT` toggles a model, not a
key. The keys are stored in `data/provider-keys.json`.
Third-party service credentials are managed under `/api/credentials`
(documented below) and stored in `credentials.db`.

There is no `/api/vault` route. A credential reaches only the agents it is switched on for
(`/api/credentials/[id]/assignments`).

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

Plugins are read per agent, from inside the agent's container. Nothing runs on the host.

### `GET /api/plugins`
The agent containers for the page's selector.

**Auth:** browser cookie

**Response:** `{ "agents": [ { "container": "agent_2a3c3a07", "label": "Atlas", "running": true } ], "dockerAvailable": true }`. With Docker down: `{ "agents": [], "dockerAvailable": false }`.

### `GET /api/plugins?agent=<container>`
The plugins of one running agent. The route runs `openclaw plugins list --json` in the container through `dockerExec` (argv, 60 s limit; it needs no gateway), parses it with `lib/agent-plugins.ts` and caches the result per container for about 60 s. Concurrent requests for one container share a single CLI run; if every waiting request is dropped (the page switched agent) the run is cancelled. `fresh=1` (the Reload and Retry buttons only) skips the cache and joins only a run started after the request arrived. Log lines before or after the JSON are ignored, a repeated plugin id keeps its first entry, descriptions are cut at 500 characters and the list at 2,000 entries.

**Auth:** browser cookie

**Response:** `{ "agent": "agent_2a3c3a07", "plugins": [ { "id": "file-transfer", "name": "File Transfer", "version": "1.0.0", "description": "...", "enabled": true, "status": "loaded", "origin": "bundled", "tools": 3, "hooks": 1, "channels": [], "providers": [] } ], "truncated": false }`, enabled plugins first, then by name. `truncated` is `true` when the list was cut at 2,000 entries.

**Errors** (short messages; the CLI's own output is only logged on the server): `400` invalid or unknown agent; `500` "Could not list plugins" for any other failure; `502` the agent is stopped, did not answer in time, returned an unreadable list, or runs an OpenClaw that cannot list plugins ("update the agent"); `503` Docker is not available.

### `POST /api/plugins`, `PUT /api/plugins`
`405 { "error": "Not available yet" }`. Enabling and disabling plugins is not available yet.

---

## Skills

Skill discovery across three sources:
- **Shared:** skills in `~/.config/rev4a/shared/shared-skills` on the VPS host (global, available to all agents)
- **Workspace:** skills in `<workspace>/skills` inside each agent container (discovered via `docker exec`)
- **Bundled:** skills shipped with OpenClaw (read-only)

### `GET /api/skills`
List all available skills from all sources. Shared skills whose name starts with `rev4a-` are Rev4a's own and carry `"managed": true`; the page shows them read-only. Workspace skills carry `agentName`, the agent's display name (`AGENT_NAME`), or `null` when it has none; the page labels by it and shows `containerName` as a secondary detail.

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
      "agentName": "Atlas",
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
- A container skill is written with the content on stdin and the path as an argument (no shell string); `containerName` must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$`, else **400** `Invalid containerName`; the skill's directory is created when missing
- A shared path under a `rev4a-*` directory is refused with **403** `Rev4a's own skills are managed by Rev4a and cannot be edited` (the check ignores case: `Rev4a-x` is refused too)
- `skillPath` and `content` must be strings, else **400**

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
  "destPath": "~/.config/rev4a/shared/shared-skills/my-custom-skill/SKILL.md",
  "overwritten": false,
  "extraCopied": 0,
  "skipped": [],
  "skippedCount": 0
}
```

- `overwritten`: `true` if a shared skill with the same name already existed
- `extraCopied`: number of additional files (beyond SKILL.md) copied from the skill directory
- `skipped`: up to **50** extra filenames omitted because they are unsafe, exceed a limit, cannot be read or cannot be safely written. Names are returned as JSON strings (control characters are escaped); a name longer than 120 characters is cut to 120 followed by `…`, so the response stays small. Promotion still succeeds for the remaining files.
- `skippedCount`: total number of omitted extra-file entries, including those beyond the 50-name response sample. Listings are scanned iteratively; at most 200 safe names are retained for copying, and later entries are counted without being read.
- The Skills page reports partial promotion with the skipped count and filename sample;
  an ellipsis indicates more omitted entries than the returned sample.
- The folder listing (`ls -1p`) is limited to 1 MiB: over it the promote answers **413** and writes nothing; any other listing failure answers **502** and writes nothing (it is never treated as "no extra files").
- Extra filenames must be plain names of at most 255 UTF-8 bytes: empty names, `.`, `..`, `/`, `\\`, NUL, CR and LF are rejected. `....` and `..env` are allowed. The listing is `ls -1p` without `-a`, so dot-files are never listed or copied. Folders are not copied: they are reported in `skipped` (as `name/`).
- Each file is limited to **1 MiB (1,048,576 bytes)**, inclusive. An oversized `SKILL.md` returns **413** before any host writes; an oversized extra is skipped. At most **200** safe extra-file reads are attempted (failed and oversized reads count); later names are skipped.
- Every host write checks that its resolved path is inside the skill directory and that the directory's current real path is inside the shared skills root's real path. Symlink directories (including nested skill-name components), regular files in place of directories, and symlink or non-regular file destinations are refused: **403** for the skill directory or `SKILL.md`, or `skipped` for an extra. Dangling symlinks are refused too. Files are opened with `O_NOFOLLOW` before writing through the descriptor, so a final-file symlink introduced after the checks is also refused without truncating its target. Existing regular files can still be overwritten.
- The skill name is validated against `^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\/[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$`
- Container must have an `AGENT_ID` Docker label
- A `skillName` starting with `rev4a-` is refused with **403** `"rev4a-…" is reserved for Rev4a's own skills: rename the skill first`
- `containerName` must match `^[a-zA-Z0-9][a-zA-Z0-9_.-]*$` (promote, and delete when given), else **400** `Invalid containerName`

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
- A shared `rev4a-*` skill (Rev4a's own) is refused with **403** `Rev4a's own skills are managed by Rev4a and cannot be deleted`; workspace skills are not affected

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

A provider can check its fields on save: for `mongodb` the `uri` (trimmed) must start with `mongodb://` or `mongodb+srv://`, else **400** `{ error }` and nothing is stored (`validateSecret()` in `lib/credentials/providers.ts`). A missing or blank `uri` is **400** `Connection string is required`; a `uri` that is not a string (a number, an object, `null`) is the same 400 as a bad value, never a server error.

### `GET /api/credentials/[id]`
Get a single credential profile (no secret returned).

**Auth:** browser cookie or bearer token

### `PATCH /api/credentials/[id]`
Update label and/or secret of a credential. A changed secret is re-delivered to the agents it is switched on for; agents where that failed are listed in `redeliveryFailed`.

**Auth:** browser cookie or bearer token

**Body:** `{ label: string, secret: Record<string, string> }`

A filled-in field is checked like on create (400 on a bad value, including a `uri` that is not a string); a blank or `null` field keeps the stored one and is not checked.

Re-delivery runs two agents at a time. The route declares `maxDuration = 300` for serverless platforms; self-hosted Rev4a does not enforce it.

Secret fields are **merged** onto the stored payload, not substituted for it:
only the fields carrying a non-empty value are written, and every blank field
keeps whatever is already stored. This matters for the one two-field provider,
Trello, where rotating the `token` alone must leave `apiKey` intact — both are
required by the REST delivery. An empty `secret` (every field blank) therefore
updates the label only.

When the merge changes the stored payload, `last_synced_at` is reset to `NULL`, then each
agent the credential is switched on for is delivered again (same path as `PUT
.../assignments`): a success sets `last_synced_at` and the profile status again and writes a
`sync` audit entry; a failure sets the status to `error` and is kept as the assignment's
`lastError`. Agents where it failed are listed in `redeliveryFailed` (200 either way).
Agents the credential is not switched on for, and anything an earlier release delivered,
keep the previous value until switched on.

### `DELETE /api/credentials/[id]`
Delete a credential and its secret permanently. Answers 409 while it is switched on for any agent or a switch-off is still pending.

**Auth:** browser cookie or bearer token

### `GET /api/credentials/[id]/assignments`
Every agent with this credential's assignment.

**Auth:** browser cookie or bearer token

**Response:** `{ native: boolean, agents: { container, agentId, displayName, running, codex, assignment: Assignment | null }[] }` where `Assignment = { profileId, agentId, enabled, mode: 'env'|'protected', syncedAt, lastError, pendingRemoval }`. `native` means this credential's provider has a native delivery implementation in Rev4a; it does not assert that the agent's OpenClaw version supports it or that a delivery succeeded. One row per agent, stopped ones included, plus a row for every assignment whose container no longer exists. `codex` is true when the agent's model (the `main` entry of `agents.list`, else `agents.defaults.model`) runs on the ChatGPT (Codex) runtime. `enabled: false` with `pendingRemoval: false` is a switched-off row, or one replaced by another profile of the same provider; `pendingRemoval: true` means the last switch-off failed and the token may still be on the agent (`lastError` says why). No secret is returned.

### `PUT /api/credentials/[id]/assignments`
Switch the credential on or off for agents.

**Auth:** browser cookie or bearer token

**Body:** `{ agent: string, enabled: boolean, mode?: 'env'|'protected', held?: boolean, intentOnly?: boolean }` (`held: true` on a switch-off says the page saw this credential in the container, so the removal runs even when Rev4a has no enabled row for it; `intentOnly: true` with `enabled: false` only clears Rev4a's own setting and runs nothing in the container, for a row whose agent holds ANOTHER credential of the same provider, since the removal is provider-wide and would delete that one; it is refused for a row with a removal pending; both must be booleans, else 400) or `{ assignments: [...] }` (1 to 100). `protected` is reserved and returns a per-agent error. `{ agent, forget: true }` drops the row of an agent that no longer exists (409 while the container still exists). A container write answers **409 with nothing written** when the agent is stopped or busy with a job (`Not running — start the agent to change its credentials` / `Busy: <reason> — try again when it finishes`); `intentOnly` and `forget` run no container command and bypass this check. `enableAssignment`/`disableAssignment` apply the same refusal as a per-container error (so the legacy sync routes report it in `results`). Background re-apply after create, recreate, update, edit, restore, rollback, start and restart does not go through this check. The route declares `maxDuration = 300` for serverless platforms; self-hosted Rev4a does not enforce it. A batch accepts up to 100 items.

**Response:** `{ results: { container, status: 'ok'|'error', error?: string }[], agents: [...] }` (same `agents` as GET). When the changes were made but only the final read of the rows failed, the answer is still 200 with `{ results, refreshFailed: true }` and no `agents`; the caller re-reads with GET. A delivery failure is a per-agent result and the assignment's `lastError`, not an HTTP error. 404 for an unknown credential or, when enabling, an unknown agent. Errors never contain secret values.

Enabling needs OpenClaw 2026.9.0 or newer on the agent (Trello and MongoDB need 2026.9.9: Trello's image ships the `jq` its skill requires, MongoDB is the only release it was verified on); an older agent returns a per-agent version refusal without creating an enabled assignment or changing a prior assignment. A success updates `last_synced_at` and the profile status and writes a `sync` audit entry. A failed delivery sets the error status without changing `last_synced_at`, which records the last successful delivery. A result may carry `warning` when the switch worked but something an earlier release wrote (old CLI files, the TOOLS.md row) could not be removed.

**Slow OpenClaw reloads.** Credential config patches and secrets reloads each request a
150-second deadline (`OPENCLAW_RELOAD_TIMEOUT_MS`), on enable, disable, MongoDB rollback
and background re-apply. Other native and managed steps keep their 30-second default;
MongoDB retains its existing five-minute install and 60-second skill-check ceilings.
After a config-patch timeout, Rev4a reads `/root/.openclaw/openclaw.json` directly with
`cat` (up to 5 seconds, no Gateway call). If every patched value matches, it continues
with the remaining delivery steps; unrelated config keys are ignored and a `null` patch
requires that key to be absent. An absent, unreadable, incomplete or mismatching file
returns **"The agent is still applying the change (OpenClaw is slow to reload); try again
in a minute."** No patch is resubmitted during this recovery. A secrets reload timeout
cannot be confirmed from the file and returns **"The secrets reload could not be
confirmed (OpenClaw is slow to reload); try again in a minute."** These errors appear
in the per-agent result and `lastError`, with no raw timeout text or secret values.

One switch can take a few minutes on a slow agent, longer when MongoDB must install
mongosh or the agent config lock is queued. Self-hosted Rev4a does not enforce the
route's serverless `maxDuration = 300`; there is no request-wide delivery deadline.
Each step waits for its docker exec to return or be killed, including any timeout-wrapper
fallback, before releasing the agent config lock. The UI keeps the active row in a loading state (switch spinner or action-button
spinner) and sibling actions disabled until the request settles.

After startup sync, a background repair checks running agents for enabled assignments
whose `last_error` contains "timed out or was killed" or "exit 137" (the old 30-second
kill). One agent at a time it waits for the agent's Gateway (up to 2 minutes, else the next
start retries), switches each such credential on again through the Switch's own path (a success
supersedes the other credential of that provider; two timed-out credentials of one provider are
left alone, with a log line asking to choose in Credentials) and logs
`[rev4a] Credentials re-applied after a timeout: <agent>` or a failure line per agent.
It never waits for delivery during dashboard startup. Success clears `last_error`, so
the next start skips the repaired assignment; stopped agents retain their usual
start-time re-apply. Other failed enabled assignments and pending removals keep their
existing lifecycle retry and manual **Redeliver** / **Retry removal** paths.
Credential payloads, version floors, stdin transport and redaction are unchanged.

Two providers are delivered without a secret-store environment entry, because that cannot work: OpenClaw reserves `GH_TOKEN`/`GITHUB_TOKEN` (a store `env` entry for them is dropped before any command runs), so GitHub goes through OpenClaw's **managed GitHub identity** — a one-use `github-setup-<hex>` handoff plus `tools.github.configure` (`mode: managed`); and the Vercel CLI ignores a token-only environment (it forces the account default team), so Vercel is written as the CLI's own `auth.json` + `config.json {currentTeam}` with an accessible team discovered from the Vercel API (`lib/credentials/managed.ts`). Every Gateway CLI call of the delivery (reload, GitHub RPCs) runs through `lib/gateway-cli.ts`, which uses the token in `/root/.agent-token` when present (a rotated token) and the container's `OPENCLAW_GATEWAY_TOKEN` otherwise.

Disabling tries every supported step (each `rm`, the skill entry, the reload) even when one fails. Any failure leaves a row in `pendingRemoval` with `lastError`, including a failed `held: true` removal with no previous row; the removal is retried when Rev4a re-applies the agent's config, and the credential cannot be deleted meanwhile. A row replaced by another profile of the same provider is not touched on the agent (the environment names are shared). A success writes a `desync` audit entry. When the last TOOLS.md integration row is removed, its entire marker block is removed.

### `GET /api/credentials/assignments?agent=<container>`
Every assignment (enabled, switched off, removal pending, failed; optionally of one agent) with the credential `label` and `providerId`, plus `knownAgents`: the containers that exist, running or stopped, and `agents`: per known agent `{ container, displayName, running, busy }` (`displayName` is the `AGENT_NAME` env or null; `busy` is the reason from `agentBusyReason` while an update, recreate, restore, edit, backup or memory-limit change owns the agent, else null). Reads the vault database and one `docker ps`/`inspect`; never execs into an agent.

**Auth:** browser cookie or bearer token

### `POST /api/credentials/[id]/sync`
Kept for older clients: enables the credential on agent containers.

**Auth:** browser cookie or bearer token

**Body (optional):** `{ containers?: string[] }` — if omitted, every agent container carrying an `AGENT_ID` label.

**Response:** `{ results: { container: string, status: 'ok'|'error', error?: string }[] }`

Each container is handled as `PUT .../assignments` with `enabled: true`. Containers outside `containers` are not touched.

### `DELETE /api/credentials/[id]/sync`
Switch the credential off on a single container.

**Auth:** browser cookie or bearer token

**Body:** `{ container: string }` — required.

**Response:** `{ ok: true }`, or 502 `{ error }` when the entries could not be removed.

Removes the secret store entries and the skill entry, anything an earlier release wrote
(CLI auth files, TOOLS.md row), and — for the two special providers — the managed GitHub
override (`tools.github.configure`, `mode: inherit`) or the Vercel `auth.json`/`config.json`.
`last_synced_at` stays untouched; the audit entry is `desync`.

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
      "trelloCliInstalled": false,
      "notionLoggedIn": false,
      "mongoshVersion": "2.13.0",
      "codex": false,
      "toolsMdHasMarkers": true,
      "matchedProfiles": [
        { "profileId": "cred_xxx", "providerId": "github-pat", "label": "GitHub" }
      ],
      "installedProviders": ["github-pat"],
      "credentials": [
        { "providerId": "github-pat", "present": true, "profileId": "cred_xxx", "profileIds": ["cred_xxx"], "method": "github-identity", "login": "Flame0510" },
        { "providerId": "trello", "present": false, "profileId": null, "profileIds": [], "method": null }
      ]
    }
  ]
}
```

`credentials` has one entry per provider and is what the Credentials page's switches show (the container
is the source of truth; the assignments table is only Rev4a's intent). `present` is true when the agent
holds a credential of that provider by any method, `false` when the container was read and holds none,
and `null` when it could not be read for that provider: the secret store failed to open (Trello, Notion, Supabase, MongoDB
only: a locked or corrupt database or a read error) or the in-container script did not finish (every provider). An older database without `secret_store_entries` is a successful empty store read.
A `null` is never "holds nothing": the page then shows Rev4a's own setting with a note. A managed GitHub
profile id with no `hosts.yml` of its own is `present: false` (the identity cannot authenticate). `method` is `store` (OpenClaw secret store: Trello,
Notion, Supabase, MongoDB), `github-identity` (the managed GitHub identity, read from its private profile),
`vercel-files` (the Vercel CLI files) or `legacy-files` (a file an earlier release wrote). `profileId`
is the stored credential whose token hash equals the one the agent holds (`profileIds` lists every match);
null with `present: true` means the agent holds a token no stored credential accounts for. `login` is
the GitHub login when known. The response never contains a token or a hash.

An agent whose probe failed is returned in its place as
`{ "container", "agentId", "error" }` — none of the fields above are present, so
consumers must check `error` first.

Each container is read with a **single** `docker exec` running one script that
emits NUL-delimited key/value pairs; containers are probed concurrently. The
script reads the credential files directly and the parsing happens in
JavaScript. Three CLI calls run last and may feed display fields — `githubUser`,
`vercelUser`, `vercelTeam`, and the `githubLoggedIn` / `vercelLoggedIn` /
`supabaseLoggedIn` flags, along with `supabaseLinked` and `supabaseProjectRef`,
which are read only when `supabaseLoggedIn` is true. `supabaseLoggedIn` follows
`githubLoggedIn` and `githubUser` also read the managed GitHub identity when present.
`supabaseLoggedIn` follows
the **exit status** of `supabase projects list`, not the text it prints, so a
failure whose wording is unfamiliar still reads as not logged in.
`vercelLoggedIn` likewise needs `vercel whoami` to exit 0 with a plain username
(one line, no spaces, not starting with `>`, `Error` or `Vercel CLI`); the hint a
logged-out CLI prints ("> Run `vercel deploy --temporary` … `vercel login` to log
in.") is not a user, and gives `vercelLoggedIn: false`, `vercelUser: ""`.
`mongoshVersion` is the version in `/root/.local/lib/node_modules/mongosh/package.json` (`""` when mongosh is not installed or the file is unreadable); it comes from the same single in-container script, no extra `docker exec`. `trelloLoggedIn` and `notionLoggedIn` come from the config files instead, and so
survive a probe cut short. The three calls reach the network from inside the
container, so a completion sentinel is emitted before them: a probe cut short
during them still yields valid token matching, with those display fields empty.

Credential files read: `~/.config/gh/hosts.yml`,
`~/.openclaw/state/openclaw.sqlite` (`secret_store_entries`),
`~/.openclaw/openclaw.json` (`agents.entries.main.tools.github.profileId`),
`~/.openclaw/credentials/github/agents/*/<profileId>/hosts.yml` for the managed GitHub identity,
`~/.local/share/com.vercel.cli/auth.json` and `config.json`,
`~/.supabase/access-token` and `/data/supabase/config.toml`,
`~/.config/trello/config.json`, `~/.config/notion/config.json`, `~/.local/lib/node_modules/mongosh/package.json` (version only), plus TOOLS.md
markers at `/root/.openclaw/workspace/TOOLS.md`. The managed GitHub identity and secret store contribute to `githubLoggedIn` and `matchedProfiles` when their tokens match stored profiles. `trelloCliInstalled` is a legacy CLI probe; it is false on the 2026.9.9 image, whose bundled Trello skill uses `curl` and `jq`. The detect route allows up to 300 seconds for its container probes.

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

## Subscriptions

ChatGPT (Codex) accounts and Claude (Pro/Max) plans per agent. Both live in the agent's own
volume; Rev4a stores nothing. All routes need auth; mutating routes answer **409** when the agent
is busy (update, recreate, restore, edit, backup, a subscription login of either provider or a
subscription disconnect running), stopped, or already doing a subscription change. A login that
is starting or waiting keeps the agent busy for up to the code lifetime: stop, start, restart,
recreate, update, edit, model save and token rotation answer 409 (or skip the agent) until the
login ends or is cancelled.

The read routes `GET /api/subscriptions`, `GET /api/subscriptions/models` and
`GET /api/subscriptions/usage` accept an optional `provider=<id>` query parameter, resolved by
`providerFromParam` in `lib/subscription-providers.ts` (the one registry of subscription
providers: `openai`, "ChatGPT (Codex)", and `anthropic`, "Claude (via Claude Code)"). Missing or
empty means the default provider (`openai`), so every existing request gets the same answer as
before. An unknown value answers **400** `{ "error": "Unknown subscription provider" }`. The
Claude routes and answers are documented under [Claude](#claude-claude-code) below; the list form
of `GET /api/subscriptions` still announces only `openai`, because the page does not render the
Claude accordion yet.

Every status, model and login answer of the subscription routes carries `Cache-Control: no-store`:
a status can change between two reads, and the login answers carry a link and an account email.

Status is read with **one `docker exec <container> node -e <script>`** inside the agent (about 0.5 s): the script opens `~/.openclaw/state/openclaw.sqlite` read-only, reads the `authProfiles.store` row and `agents.defaults.model` from `openclaw.json`, and prints one JSON line with only `id, type, provider, email, expiresAt, plan` per profile and the model. `access`, `refresh` and `accountId` are never copied: the tokens do not leave the container. An agent whose state is not where a supported version keeps it (no `node:sqlite`, no state database, no profile table) gets one refusal, "This agent is not on a supported OpenClaw version (2026.9.x). Update it first." (the list of majors comes from `lib/agent-versions.json`), unless its image is a supported version: then the database simply does not exist yet (an agent just created or recreated) and the read fails with `the agent is still starting`; a read that fails gets "Could not read this agent's subscription status: <reason>". `<reason>` is one fixed phrase, never the agent's own text: `state database locked`, `state database unreadable`, `profile store unreadable`, `timed out`, `the read was cut off (timed out)`, `the container is not running`, `the agent answered in an unexpected format`, `the agent is still starting` or `the read failed`. There is no CLI fallback. A failed read is retried by the server up to twice (after 1 s, then 2 s), never an answer that was read; a timeout (12 s per read) is retried once at most and a stopped container not at all, so the worst case is about 27 s and a non-timeout failure costs at most 3 s. How each route answers: `GET /api/subscriptions?agentId=` is **200** with the message in `agent.error`; `POST /api/subscriptions/openai/login` answers **409** (unsupported) or **503** (failed read); a login that ended while the agent could not be read finishes as `failed` with "The login may have succeeded but the agent could not be read: <reason>. Reload to check."; `PUT /api/gateway/agent` with a subscription model answers **409** or **503**; the disconnect job (`POST /api/subscriptions/openai/logout`, then `GET`) ends `failed` with that message when its first read fails, and with "Could not read the subscription status from this agent." when a later check fails. The lookup of accounts behind the models and usage reads reads each agent once, without retries (a failing agent is skipped). The page shows a Retry button next to such a row error. The page therefore loads in steps: the agent list, then one status per row in parallel, then the models. The container list behind these routes is cached 5 s, and the email-to-agent lookup used by the models and usage reads 60 s (dropped by a connect or disconnect).

### `GET /api/subscriptions`
The agent list, at once, from docker ps and inspect only (no exec into any agent). **Query:** optional `provider=<id>` (default `openai`; unknown → **400** `{ "error": "Unknown subscription provider" }`), and `agentId=<id>` for one agent. **Response:** `{ providers: [{ id: "openai", name: "ChatGPT (Codex)", agents: [{ agentId, name, container, running }] }] }`. One entry per registry provider that has a server implementation announced here; today only `openai`, although Claude's routes exist, because the page does not render the Claude accordion yet. `name` is the agent's display name (its `AGENT_NAME`); `container` is the container name.

### `GET /api/subscriptions?agentId=<id>`
One agent's status, read live. **Query:** `agentId` and the optional `provider=<id>` (default `openai`; unknown → **400** `{ "error": "Unknown subscription provider" }`). An unsupported or unreadable agent is a row with `error` set to the same messages (not an HTTP error). **Response:** `{ agent: { agentId, name, container, running, connected, email, plan, expiresAt, usesSubscription, primary, fallbacks, error }, action }`. `plan` is the ChatGPT plan, capitalised ("Plus", "Pro"), null when unknown. `action` is the agent's running or last disconnect job (or null), so a reloaded page resumes a running one. A stopped agent has `running: false` and unknown status. With `provider=anthropic` the row additionally carries `claude: { state, installed, version }` and `action` is the Claude logout job only; see [Claude](#claude-claude-code).

The additive `agent.profileReferences` array lists all relevant ChatGPT OAuth profiles as
`{ id, email, plan, expiresAt }`. API-key and other-provider profiles are excluded; access/refresh
tokens, account IDs and authorization grants are never returned. It is read-only reference metadata,
not an account selection or adoption result. Older clients may ignore it; newer clients tolerate its
absence from older responses.

### `GET /api/subscriptions/models`
**Query:** optional `provider=<id>` (default `openai`; unknown → **400** `{ "error": "Unknown subscription provider" }`). **Response:** `{ models: [{ key, name, contextWindow }], error, pending }`. The models the connected accounts offer: one `openclaw models list` CLI call per distinct account (about 7 s), cached 10 min per account email and dropped by a connect or disconnect; finding a connected agent uses the cached status read only (an unsupported or unreadable agent cannot be a source). Right after Connect, OpenClaw installs the Codex plugin and hot-reloads its config (about a minute); until then the agent lists no model. Such an empty list is never cached, and the answer carries `pending: true` whenever any successfully read account is still empty, even alongside partial `models` or another account's `error`. Available models are retained and cached independently while pending accounts retry. With no available models the Subscriptions page shows "Loading ChatGPT models…" and the MODEL section keeps "Loading subscription models…", both asking again every 5 s for at most 3 minutes. Independent deadline timers abort fetch/body reads at that limit, keep partial models and publish a retry message. The response remains `{ models, error, pending }`. With `provider=anthropic` the answer lists the models of the connected Claude plans that Claude Code can run (`available: true` only); see [Claude](#claude-claude-code).

### `GET /api/subscriptions/usage`
**Query:** `email=<account>` for one account, `refresh=1` to bypass the cache, optional `provider=<id>` (default `openai`; unknown → **400** `{ "error": "Unknown subscription provider" }`; a known provider without usage limits → **400** `{ "error": "This subscription provider has no usage limits" }`). **Response:** `{ accounts: [{ email, plan, windows: [{ label, usedPercent, resetAt }], updatedAt }], errors: [{ email, message }] }` (`label` is OpenClaw's own label, seen as "5h" and "Week", `usedPercent` 0-100, `resetAt` and `updatedAt` ISO times). The ChatGPT (Codex) usage limits of each connected account. The quota is the account's, shared by every agent signed in with it and the owner's own Codex use, so it is read once per account from one running connected agent (`openclaw status --usage --json` under an in-container `timeout 120`; 11 to 50 s on a slow host) and cached 3 minutes per account, failures included, so the next refresh does not start another CLI. A connect or disconnect does not drop this cache; `refresh=1` is the only way to force a read. One account that cannot be read is an entry in `errors` ("Could not read the usage from <agent name>"), never a failed response.

### `POST /api/subscriptions/openai/login`
**Body:** `{ "agentId": "atlas" }`. Starts the device-code login (waits for the agent's Gateway to be ready, then runs `openclaw models auth login --provider openai --device-code` inside the container). **Response:** `{ login }` with `state` `starting`. 409 when the agent is stopped, busy, already connected, or not on a supported OpenClaw version ("This agent is not on a supported OpenClaw version (2026.9.x). Update it first."); 503 when its subscription status cannot be read ("Could not read this agent's subscription status: <reason>"). Every login answer carries `Cache-Control: no-store` (the body holds the device code). When a login is already running for the agent, the same `{ login }` is returned with 200 (a second tab or a reopened dialog resumes it), also for a login that has just connected and whose CLI is still finishing. `expiresAt` in the login is epoch milliseconds. A busy login lasts at most 60 s readiness + 900 s + 60 s tail; after 1020 s the job counts as expired.

### `GET /api/subscriptions/openai/login?agentId=<id>`
**Response:** `{ login }`, or `{ login: null }` when there is none: `{ agentId, state, url, code, expiresAt, email, error }`, `state` one of `starting`, `waiting`, `connected`, `failed`, `expired`, `cancelled`. The job is in memory; a dashboard restart loses it.

### `DELETE /api/subscriptions/openai/login?agentId=<id>`
Cancels the login, including the process inside the container. **Response:** `{ login }` with the job as it stands (`cancelled`, or its final state if it had already ended), `{ login: null }` when there is none.

### `POST /api/subscriptions/openai/logout`
**Body:** `{ "agentId": "atlas" }`. Starts the disconnect as a background job and answers **202** `{ job }` at once. The job puts the agent back on its own model if it uses the subscription, drops the remaining `openai/*` fallbacks, also reverts a subscription model in the `main` entry of `agents.list`, then runs `timeout 60 openclaw models auth logout <profile> --yes` for every ChatGPT (OAuth) profile and reads the profiles back (the job fails with "The sign-out did not complete. Try again." if one remains), then stops the agent's Codex runtime processes (best effort, no restart); an API-key `openai:` profile is left alone. It fails (`failed` with an `error`) when the agent uses the subscription model and has no model of its own to go back to. 409 when the agent is stopped, busy or already has a subscription change running.

### `GET /api/subscriptions/openai/logout?agentId=<id>`
**Response:** `{ job }`, `{ job: null }` when there is none: `{ agentId, kind: "logout", state, error }`, `state` `running` then `done` or `failed`. In memory, one per agent, kept 30 minutes after it ends; while it runs the agent counts as busy.

### Claude (Claude Code)

`provider=anthropic` is a Claude (Pro/Max) plan used through Claude Code inside the agent. Anthropic's
terms decide the shape of the flow: the sign-in happens in Anthropic's own page, Claude Code exchanges
the code and keeps the tokens in the agent's volume, and Rev4a never collects, stores or intermediates
a Claude credential. The code the operator pastes is written **once** to the stdin of the running
`claude auth login` process and dropped; it is never stored in a job, never logged, never echoed in an
answer or an error (a refused code is a `400` with "Invalid code" and nothing else). No route reads
`/root/.claude/.credentials.json` or `/root/.claude.json`, and there is no setup-token method.

Status is read with one `docker exec <container> node -e <script>` inside the agent: it checks
`/root/.local/bin/claude`, runs `claude --version` and `claude auth status --json` (each under a 15 s
timeout) and reads `agents.defaults.models` and `agents.defaults.model` from `openclaw.json`, printing
one JSON line with only `loggedIn`, `authMethod`, `email`, `orgName`, the plan (`subscriptionType` or
`planTier`, capitalised) and `loginExpiresAt` — plus the installed version and the model runtime ids.
`claude auth status --json` holds no token; only those keys are copied out regardless. An agent whose
image is not on a supported OpenClaw line gets a row with `error` set to the same message as ChatGPT,
"This agent is not on a supported OpenClaw version (2026.9.x). Update it first." (**200**, not an HTTP
error: the read is `GET /api/subscriptions?agentId=<id>&provider=anthropic`); a failed read puts "Could not read this agent's
subscription status: <reason>" in the row's `error` (same fixed reasons as ChatGPT). When
`claude auth status` itself fails (a timeout, a non-JSON answer), the row's `error` is
"Could not read Claude Code's sign-in state" instead of looking like a plain sign-out.

The state is one of `not-installed` (Claude Code is missing), `signed-out`, `route-off` (signed in, but
`anthropic/*` does not use Claude Code), `connected` (signed in with `authMethod` `claude.ai`, route on,
not expired) or `needs-reconnect` (route on, signed out or expired). A sign-in with another method
(a Console/API account) is not a Claude plan: with the `anthropic/*` rule on it is `needs-reconnect`
(the operator must sign in again with a Claude plan), and with the rule off it is `signed-out`. In both
cases the row's `error` says exactly "Claude Code is signed in with an API account, not a Claude plan."

### `GET /api/subscriptions?agentId=<id>&provider=anthropic`
**Response:** `{ agent, action }`, where `agent` is the usual row (`agentId`, `name`, `container`,
`running`, `connected`, `email`, `plan`, `expiresAt`, `usesSubscription`, `primary`, `fallbacks`,
`error`) plus `claude: { state, installed, version }`, and `action` is the agent's `claude-logout` job
(running or last, or null) — never the ChatGPT one. `connected` is true exactly when `state` is
`connected`; `usesSubscription` is true when the primary starts with `anthropic/` (a `rev4a/anthropic/…`
proxy model does not count). `profileReferences` is empty. A stopped agent is `running: false` with
`claude.state` `not-installed` and nothing read from it.

### `GET /api/subscriptions/models?provider=anthropic`
**Response:** `{ models: [{ key, name, contextWindow }], error, pending }`. Like the ChatGPT models, from
connected agents only (one `openclaw models list --provider anthropic --json` per distinct account,
cached 10 minutes and dropped by a connect or disconnect), keeping only the models whose list entry says
`available: true`: those are the models Claude Code can run. An empty list is never cached and makes the
answer `pending: true`, as for ChatGPT.

### `POST /api/subscriptions/anthropic/login`
**Body:** `{ "agentId": "atlas" }`. Starts Anthropic's own sign-in through Claude Code. When
`/root/.local/bin/claude` is missing it first installs Claude Code with Anthropic's installer
(`curl -fsSL https://claude.ai/install.sh | bash`, bounded by `timeout 300`), then runs
`timeout 600 script -e -qfc "/root/.local/bin/claude auth login" /dev/null` with stdin piped. **Response:** `{ login }`
with `{ agentId, state, url, email, plan, error }`, `state` one of `starting`, `installing`, `waiting`,
`verifying`, `connecting`, `connected`, `failed`, `expired`, `cancelled`. `url` is Anthropic's link and
is shown only when it starts with `https://claude.com/cai/oauth/authorize?` or
`https://claude.ai/oauth/authorize?`, is at most 2048 characters and carries no whitespace or control
character: any other link is dropped. When a login is already running for the agent, the same `{ login }`
is returned with 200. 409 when the agent is stopped, busy, already connected, or not on a supported
OpenClaw version; 503 when its status cannot be read. The job is in memory, one per agent; a dashboard
restart loses it, and the in-container `timeout` bounds the orphaned process.

### `GET /api/subscriptions/anthropic/login?agentId=<id>`
**Response:** `{ login }`, `{ login: null }` when there is none. It carries no code and no token, only the
link and the outcome. A job that has not finished 300 + 600 + 60 = 960 s after it started counts as
expired (its agent stops being busy).

### `DELETE /api/subscriptions/anthropic/login?agentId=<id>`
Cancels the login, including the `claude auth login` process inside the container (found through
`/proc`; the images have no `ps`). An installer already running keeps its own `timeout 300` and
does not start a login afterwards. **Response:** `{ login }` with the job as it stands
(`cancelled`, or its final state if it had already ended), `{ login: null }` when there is none.

### `POST /api/subscriptions/anthropic/login/code`
**Body:** `{ "agentId": "atlas", "code": "<the code Claude Code shows>" }`. Writes the code to the
waiting process's stdin (the code followed by a carriage return) and answers `{ login }` with state
`verifying`. The body is never logged. `400` `{ "error": "Invalid code" }` when the code is not a string
of 8 to 512 characters from `A-Z a-z 0-9 . _ ~ # + / = -`, or when it contains any control character
(a newline would feed the process a second line); surrounding spaces are dropped. `409` when no login of
the agent is waiting for a code or one has already been submitted. On exit 0 the job reads
`claude auth status --json`: when it says a Claude plan is signed in, the job writes
`{"agents":{"defaults":{"models":{"anthropic/*":{"agentRuntime":{"id":"claude-cli"}}}}}}` with
`openclaw config patch --stdin`, reads it back and reports `connected` (with the account email and plan);
otherwise it reports `failed` with a clear message. A wrong code exits 1 and the job reports
Anthropic's own sentence ("That code wasn't accepted. …"). `timeout` (124) or the job deadline reports
`expired`.

### `POST /api/subscriptions/anthropic/logout`
**Body:** `{ "agentId": "atlas" }`. Starts the disconnect as a background job and answers **202**
`{ job }` at once. The job reverts the `anthropic/` models in `agents.defaults.model` and in the `main`
entry of `agents.list` (a stuck agent — a `anthropic/` primary with no model of its own — makes the job
`failed` with the same sentence as ChatGPT), removes the Claude Code runtime rule with
`openclaw config patch --stdin` (the `anthropic/*` key is sent as `null`; when it was the only key
`models` itself is nulled, so no empty `models` object is left behind), runs
`timeout 60 /root/.local/bin/claude auth logout` and reads the status back, which must say logged out.
The binary stays: it is the runtime the agent uses again on the next connect. 409 when the agent is
stopped, busy (a running login included) or already has a subscription change running.

### `GET /api/subscriptions/anthropic/logout?agentId=<id>`
**Response:** `{ job }`, `{ job: null }` when there is none: `{ agentId, kind: "claude-logout", state,
error }`, `state` `running` then `done` or `failed`. In memory, one per agent across both providers,
kept 30 minutes after it ends; while it runs the agent counts as busy.

### `PUT /api/gateway/agent` and subscription models
A model id sent as `subscription:openai/<id>` is stored as the bare `openai/<id>` (a subscription model); without the prefix every id still gets `rev4a/`, so a Rev4a catalogue model named `openai/…` stays `rev4a/openai/…`. A marked id must match `subscription:openai/[A-Za-z0-9._-]+`, otherwise `400`. When the body carries any marked id the route reads the agent's ChatGPT sign-in first: `409` "This agent is not connected to a ChatGPT subscription." if there is none, `503` if the status cannot be read. When `fallbacks` is omitted the stored ones are kept as they are (a stored bare `openai/<id>` is not re-prefixed). A primary or fallback can therefore be a bare `openai/<id>` subscription model; the agent list shows it as "<id> · ChatGPT", with the `NO FALLBACK` warning when it has no fallback.

There is no route that chooses a subscription model: the agent's model (primary and fallbacks) is chosen in one place, the MODEL section of the agent panel, which sends `PUT /api/gateway/agent` with `{ containerName, model, fallbacks }`. Each of `model` and the entries of `fallbacks` is either a Rev4a catalogue id (stored as `rev4a/<id>`) or a `subscription:openai/<id>` mark (stored as the bare `openai/<id>`), in any combination. The MODEL section reads the agent's connection from `GET /api/subscriptions?agentId=` and the models from `GET /api/subscriptions/models`, and offers the second group only when the agent is connected.

---

## Diagnostics

### `GET /api/debug`
Whether the three auth-related environment variables are set. Booleans only —
no value, masked or otherwise, is returned.

**Auth:** browser cookie or bearer token

**Response:** `{ "hasPassword": true, "hasJwtSecret": true, "hasToken": false }`

### `GET /api/envcheck`
A fixed list of environment keys, for diagnostics: `REV4A_PASSWORD`, `REV4A_TOKEN`,
`REV4A_JWT_SECRET`, `REV4A_ALERTS_ENABLED`, `REV4A_DB`,
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
  "PROVIDER_DEEPSEEK_API_KEY": "set",
  "NODE_ENV": "production"
}
```

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
this server stays up through the install and the build, and only `rev4a restart` at the
end of the update stops it (`fuser -k <port>/tcp`); `rev4a serve` then brings the child
back on the new binary via its `.restart-flag`, so the connection drops and the page has
to wait for the server to answer again.

The child's output goes to `update.log` under `<REV4A_DATA_DIR>/data` (or
`~/.config/rev4a/data` by default) — the update restarts the process that spawned
it, so that file is the only record of what happened. The endpoint creates the
directory if needed and reports a failure if it cannot start the updater.

**Auth:** browser cookie or bearer token

**Response:** `{ "success": true, "message": "...", "log": "update.log" }`, or `409`
`{ "success": false, "error": "An update is already running." }` when an update is in
progress (another tab, or one started from a terminal).

The route claims the update before it spawns anything: it checks for a running update and
writes `starting` (this server's pid, a unique `claim` token) in one synchronous step with
no await in between, so two simultaneous requests cannot both start an updater (the loser
gets the `409`). The child gets the claim in `REV4A_UPDATE_CLAIM`, so `rev4a update` does
not refuse its own run; once the child exists its pid replaces the server's, but only if the
state on disk still carries the same claim. A spawn error marks the claimed run `failed`.
`rev4a update` started from a terminal refuses while another update is in progress.
`rev4a update` then writes the rest (see `GET /api/update-status`).

The banner records what it asked for, polls `/api/update-status` until the version the
server runs moves (or two and a half minutes pass), reloads, and on the next mount either confirms
"Updated to vX" or reports that the update did not complete and points at the log.

### `GET /api/update-status`
Where the running update is, for the "Updating Rev4a" screen that every tab shows. Cheap and
local: one small file and the tail of `update.log`, no network.

**Auth:** browser cookie or bearer token

**Response:**
```json
{ "running": true, "phase": "installing", "from": "1.13.2", "to": "1.14.0",
  "startedAt": 1790000000000, "updatedAt": 1790000004000, "error": null,
  "version": "1.13.2", "logTail": ["…last 20 lines of update.log…"] }
```

- `phase` is `starting`, `installing`, `building`, `restarting`, `done` or `failed`
  (`null` when there is no recent update). `running` is true in every phase but `done`
  and `failed`. `error` is set when `phase` is `failed`.
- The state is `update-state.json` in the Rev4a data directory (`<REV4A_DATA_DIR>/data`),
  written by `rev4a update` (lib/update-state.js). A state older than 30 minutes, or
  written more than 5 minutes in the future (a clock that stepped back), counts as no update. A state whose updater process is gone while it was starting, installing or building
  reads as `failed` (a crash or a kill). `restarting` is resolved only by the server process itself
  (`server.js` sets `REV4A_SERVER_PID`; a `rev4a update` started later from a shell never
  resolves it): done once a server that started
  after it answers *and runs the target version*; a server that started on another version
  turns it into `failed` ("Rev4a restarted on X, not Y"). The updater has exited by then on
  purpose, so its pid is not checked in that phase; a `restarting` no server has picked up
  after 5 minutes turns `failed` ("Rev4a did not restart within 5 minutes…"), whoever reads it.
- `version` is the version this server process runs, recorded once by `server.js` when it
  started (`REV4A_RUNNING_VERSION`, with `REV4A_STARTED_AT`). It is not `package.json` on
  disk: npm replaces that before the build and the restart, while the old server still
  answers. The screen and the banner treat "the new version answers" as this value being
  readable and different from the version the update started from.
- `logTail` is the output of this run only (terminal control codes removed): the lines after
  the marker the dashboard writes to `update.log` when it starts the run
  (`[<iso>] rev4a update <startedAt>, started from the dashboard`, with the state's
  `startedAt`), at most 20. It is `[]` when there is no such marker: an update started from a
  shell writes to its terminal, not to `update.log`. The "update process stopped" error
  points at `update.log` or the terminal the update was started from. Output has
  secrets redacted (each line cut at 500 characters first): the value after a
  secret-looking name (`NAME=value`, `NAME: rest of line`, quoted JSON keys; names with a
  token / secret / password / credential / cookie / authorization part, or ending in key /
  auth / pass — `author` or `keyv` are left alone), `--…password|token|secret|key` flags,
  `Bearer` / `Basic` values, `token` followed by a long value, `npm_…`, `sk-…`, GitHub
  (`ghp_…`, `github_pat_…`), GitLab (`glpat-`), Slack (`xox…-`), AWS (`AKIA…`) and Google
  (`AIza…`) keys, JWTs, and URL credentials (`user:pass@`, `:pass@` or a token alone before
  `@`) become `[redacted]`.
  `error` is redacted the same way.

#### Updates block writes
While an update is in progress, every mutating API request (`POST`, `PUT`, `PATCH`,
`DELETE`) answers `503` `{ "error": "Rev4a is updating", "phase": "installing" }` with a
`Retry-After` header. The guard is in `proxy.ts`, the one place every request passes, so a
new route is covered without anyone remembering to. Exempt: `/api/auth/*` (sign in and out),
`/api/update-check`, `/api/update-status` and `/api/provider/*` (the agents' provider
proxy keeps working during the update). Reads and page loads are not blocked.

### `POST /api/alerts/snooze`
Snoozes the spend and loop alarms of one agent: the daemon keeps evaluating it and does not alert until the snooze ends. Stored in `events.db` `alert_state` (`spend-snooze:<agent>`), so it survives a restart.

**Auth:** browser cookie or Bearer

**Body:** `{ "agent": "writer", "hours": 24 }` — `agent` is an agent id, a container name or `vendor:<name>` (the alarm's `scope`); `hours` is optional (default 24, at most 720).

**Response:** `{ "ok": true, "agent": "writer", "until": 1790876025355 }` (`until` in milliseconds).

**Errors:** `400` for an invalid `agent` or `hours`; `500` when the database cannot be written.

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

Common status codes: `400` bad request, `401` unauthorized, `404` not found, `500` server error, `503` Rev4a is updating (mutating requests only, see `GET /api/update-status`).

## OpenClaw compatibility safeguards

Create (`POST /api/agents/create`) and Update refuse resource admission before lifecycle mutation.
For exact 2026.10.10 a finite cap must be at least 4096 MiB; no cap remains unlimited and no global
default changes. Unknown/insufficient Docker capacity is explicit (Create:409; Update refusal:409).
Running containers and concurrent requests share a conservative planning budget; this is not a
universal native-host minimum. Older 9.3/9.9 operator-selected caps remain supported.

Update verification preserves cron identity/ownership and accepts only the exact evaluated upstream
retirement. Update views/history add `cronRepair` for separate legacy failure audit evidence; original
`verification`, failure and timestamps remain available. `retiredCronJobs` is additive verification
metadata. The retirement-aware repair also handles later bounded panel retries when startup
verification could not reach the Gateway. Original failure evidence is preserved.

Update views/history add nullable `cronAccountAdoption`: `{ associated, noBindingNeeded,
alreadyAssociated, skipped, failed, note }`. `noBindingNeeded` is additive and absent on older stored
results. `associated` requires verification of the saved binding to the intended account after
restoring the model. Routes without a binding increment `noBindingNeeded`; the Agents note says
**no binding needed (model left/restored)**. After successful 9.x -> 2026.10.10 verification, the explicit migration policy
adopts affected ChatGPT/Codex cron jobs only when exactly one OAuth profile is connected. It uses
native `cron.update` with revision preconditions, then restores each original model (NULL/Default
retains primary and fallback inheritance). It never changes schedules, delivery or enabled state.
Zero/multiple profiles leave jobs unchanged with guidance. Adoption failures are reported without
failing Update; a failed cleanup of a temporary model override is explicitly flagged for review.

Restore GET adds `phase`, `recoveryFile` and `preflight` (NULL on old rows). A legacy `done` row
without readiness evidence is not proof of a healthy Gateway and is shown as such in the panel.

Rollback reclaims the exact ended latest update in an immediate transaction after its asynchronous
backup/container checks. A competing lifecycle claim, changed status or superseding update returns409
before the rollback worker is scheduled. It never reactivates an arbitrary historical row.
Legacy `done` Restore rows receive an unverified-readiness warning; this is operator review guidance,
not a startup audit or an automatic reconstruction of historical restore success.

### `POST /api/agents/[id]/restore/resolve`

Manually resolve an `unresolved` restore after operator confirmation in Agents > Backups.
**Auth:** `requireAuthJWT` (dashboard cookie or configured Bearer token).
**Body:** `{ "restoreId": 123 }` — a positive safe integer matching the latest unresolved row.

Selects containers with Docker's label filter for both `rev4a.restore.agent=<id>` and
`rev4a.restore.id=<restoreId>`, verifies ownership, stops/removes only those helpers and confirms
absence before releasing the reservation. No mount-based selection, agent stop/removal or automatic
restart/extraction occurs. Cold-backup helpers have no restore label and are left untouched.
No labelled container is a valid resolved result. The retained row records `status: interrupted`,
`phase: manually_resolved`, the outcome and completion time; the operator must still review
partial data before starting the agent or restoring the recovery backup.

**Response:** `{ "resolved": true, "restore": { ... } }` (200).
**Errors:** 400 invalid agent/body; 401 unauthenticated; 409 stale/non-unresolved row, duplicate
action, unreachable Docker or unconfirmed cleanup; 500 unexpected failure. Failed cleanup retains
`unresolved` and the pinned source; retry explicitly once Docker is available. A stale row ID
cannot resolve a newer restore.

Startup only marks active restores interrupted for review; an extraction interrupted by a server
restart becomes unresolved and names its helper. Existing unresolved and historical rows are not
scanned or cleaned up automatically. Cron-account journal entries are per update so rollback and
re-upgrade do not skip adoption; pending exact model pins can be repaired without a native binding.
A new Update supersedes earlier unfinished journals in the same transaction as its lifecycle claim.
Adoption runs under that claim. Background repair only considers the latest update's journal,
acquires an exclusive claim for that agent and skips busy agents until the next retry. Superseded
journals are never reconciled.
