# Rev4a Architecture — Design & Vision

> **Status:** Active — `main` branch
> **Last updated:** 2026-10-01
> **Goal:** Transform Rev4a from a monitoring dashboard into a central orchestrator for a distributed multi-container agency.

---

## 1. Why Multi-Container?

### Current state (single container + dashboard)

```
┌─────────────────────────────────────────────┐
│  openclaw-core (1 container)                │
│                                             │
│  Rev4a (Next.js + daemon + SQLite)        │
│  OpenClaw runtime + systemd                  │
│  Subagents via sessions_spawn (same process)│
│  3+ agent workspaces (ops, prometheus, …)   │
│                                             │
│  ⚠️ 4 CPU, 15 GB RAM shared                 │
│  ⚠️ Single Node.js event loop               │
│  ⚠️ Everything competes for CPU/IO          │
└─────────────────────────────────────────────┘
```

**Pain points:**
- CPU-bound processes (ESLint, builds, daemon polling) compete
- Single event loop saturated by too many Node tasks
- Single SQLite WAL under concurrent load
- Impossible to use frameworks other than OpenClaw (Hermes, OpenCode)

### Target vision: Rev4a as orchestrator

```
┌────────────────────────────────────────────────────────────────┐
│  DOCKER HOST                                                   │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ rev4a-control  │  │ agent-argus      │  │ agent-atlas  │ │
│  │ (orchestrator)   │  │ (OpenClaw: Ops)  │  │ (OpenClaw:   │ │
│  │                  │  │                  │  │  Development)│ │
│  │ • Dashboard UI   │  │ • Session pool   │  │ • Session    │ │
│  │ • Config DB      │  │ • 2 CPU limit    │  │ • 2 CPU      │ │
│  │ • Docker socket  │  │ • 4 GB RAM limit │  │ • 4 GB RAM   │ │
│  │ • Auth gateway   │  │ • skills (ro)    │  │ • skills (ro)│ │
│  │ • Provider proxy │  │ • repos (rw)     │  │ • repos (rw) │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘ │
│           │                     │                    │         │
│  ┌────────┴─────────┐  ┌────────┴─────────┐  ┌──────┴───────┐ │
│  │ agent-prometheus │  │ agent-hermes     │  │ agent-future │ │
│  │ (OpenClaw: CRM)  │  │ (Hermes Agent)   │  │ (OpenCode?)  │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ SHARED VOLUMES                                           │  │
│  │ • ~/.config/rev4a/shared/shared-skills → all agents (ro) │  │
│  │ • /docker/shared-repos  → shared project repos           │  │
│  └──────────────────────────────────────────────────────────┘  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Architecture (as of 2026-08-28)

### What's already been implemented

**Container separation:** `openclaw-atlas` already runs as a standalone container with `AGENT_ID=atlas`, discovered dynamically by Rev4a. This proves the container-per-agent model works.

**Credentials vault:** The `/credentials` page stores third-party service tokens in `credentials.db` and installs them into containers on explicit sync. Provider API keys live separately in `provider-keys.json`, managed from the Gateway UI.

**Container management UI:** The `/containers` page lists all Docker containers, running or stopped, with status, image, IP and ports, and opens a web terminal into any running one. Fully functional. Each running container's CPU, memory and processes are on its row, with a link to its charts on `/system`, which also shows the machine's CPU, RAM and disk.

**Workspace API:** Lazy-loaded file tree explorer with real-time reads (no caching), supports both host and container workspaces via `docker exec`.

### What's in place but needs refinement

| Feature | Status | Notes |
|---|---|---|
| Credentials (UI + API) | 🟢 Implemented | SQLite, no encryption yet |
| Container page | 🟢 Functional | Lists all containers, web terminal (xterm.js, no proxy needed) |
| Agent creation wizard | 🟢 Implemented | One-click create with model/template selection |
| Provider proxy | 🟢 Implemented | Agents route through Rev4a provider gateway |
| Shared volumes | 🟢 Implemented | Skills + repos mounted on all agents |
| Central Oracle DB | 🔴 Not started | Events are per-container |
| Auto-registration | 🔴 Not started | New containers must be manually added |

---

## 3. Components (Target Architecture)

### 3.1 Rev4a Control Plane

The central container, running the Next.js dashboard + orchestration API.

**Responsibilities:**
- Web dashboard (Next.js, port 3740)
- REST orchestration API to spawn/stop/restart agents
- AI Provider Gateway (proxy for OpenAI, Anthropic, Groq, etc.)
- Centralized credential management
- Docker socket access for container management
- SQLite DB for cross-container event monitoring
- **First-run wizard** — setup flow at `/wizard`; completion is recorded in `<data dir>/data/wizard.json` and read through `GET /api/wizard/status`

**Volume mounts (target):**
```
/path/to/rev4a/data                   → /data (persistent)
/var/run/docker.sock                  → /var/run/docker.sock
~/.config/rev4a/shared/shared-skills  → /data/.openclaw/shared-skills (ro)
/docker/shared-repos                  → /data/repos (rw)
```

**Rev4a System Rules** (`rev4a-rules/AGENTS.md`):
- Versioned in the repo, deployed to `~/.config/rev4a/shared/rev4a-rules/` on every `rev4a serve` start
- Mounted read-only into every agent at `/root/.openclaw/workspace/.rev4a/AGENTS.md`
- Injected into every session via the `bootstrap-extra-files` hook (glob `.rev4a/*.md`)
- Immutable by agents — enforced by the `:ro` mount
- See `lib/agent-setup.ts` for the centralized volume + config guarantee logic
- **Waiting for a new container** is `waitForGatewayReady()` in
  `lib/agent-readiness.ts`, used by create, recreate and the agent route. It waits for
  `/startupz` to report `started` (503 while starting or draining, a non-JSON 200 or no
  answer mean "not yet"). A Gateway that refused readiness — one that found a legacy
  session store and wants `doctor --fix` — answers 200 on `/health` while draining; the
  old fallback that accepted that as "ready" was removed with 7.x support, because it
  let callers configure an agent that was still migrating. Do not reimplement the wait in
  a route.
- **The model catalogue** is read only through `lib/model-catalogue.ts`:
  `loadModelsConfig()`, `loadOfferedModels()` (enabled after overrides, provider has
  a key), `isModelOffered()` (enforced by the proxy and the assistant) and
  `catalogueStatus()`. A failed read of `models.config.json` falls back to the last
  good copy and never deletes overrides.
- **The model data has three files and three scripts.** `models.config.json` is curated by
  hand (identity, `enabled`, `deprecated`, and an optional `info` block for what no API
  publishes: the vendor's size claim, benchmarks, the docs link, notes).
  `model-pricing.json` and `model-details.json` are **generated** by
  `npm run refresh:pricing` (`scripts/refresh-model-pricing.mjs`): prices from OpenRouter
  (cache rates included; direct vendors' prices by hand from their pricing pages),
  and per model the description, architecture and benchmarks from OpenRouter plus the size,
  weight mix, licence and dates from the Hugging Face card. Two scripts back the curation
  of `info`: `npm run info:suggest` (`scripts/model-info-suggest.mjs`) prints the candidate
  facts from a card, and `npm run info:verify` (`scripts/model-info-verify.mjs`) refuses a
  proposal the card does not support — evidence per field, every benchmark value under the
  column that names this model. `GET /api/models/details` merges the three files for the
  details modal (`docs/dev/GATEWAY.md`).
- **Agent images and OpenClaw versions.** `lib/agent-versions.json` lists the supported
  OpenClaw versions, newest first, with the model `input` list for each; the server reads
  it through `lib/agent-versions.ts`, the `rev4a` CLI with `require`. The provider sync
  takes each agent's own list (`containerVersionSync()`: image tag, else the entrypoint's
  `.last-version` file), so an agent on an older supported release is never sent an
  `input` value it would reject — one unknown value discards the whole generated
  catalogue. A version stays listed while agents still run it, and listing it is also what
  lets a rollback pull its image: since 2026.9.3 is the only entry, a rollback whose target
  is no longer listed is refused up front (`startAgentRollback()`) instead of restoring a
  volume on a version this build cannot run. `lib/agent-images.ts`
  lists local `openclaw-agent-base:<version>` images through the Docker API, reads an
  agent's version (image label or tag, else `openclaw --version` in the container, cached
  per image id), reads the registry tag list over HTTP (cached 10 min), pulls a version
  and resolves the image a recreate uses. Images are never addressed as `:latest`: create
  takes the newest supported version downloaded, recreate the agent's own.
- **Cold backups** are `lib/cold-backup.ts`. The agent is stopped and a detached helper
  container, `rev4a-backup-<id>` from the agent's own image, archives its volume to
  `rev4a-backups` as `.partial`, reads it back and renames it; the agent is started
  again if it was running. The helper and its labels are the job, so no request waits
  on it and a Rev4a restart does not lose it (`reconcileColdBackups()` in
  `instrumentation.ts`). While a helper runs, the routes that change the agent answer
  409 (`isColdBackupRunning()`), and `syncAllAgents()` skips the agent.
- **Agent updates** are `lib/agent-update.ts`, with their state in the `agent_upgrades`
  table (`lib/agent-update-state.ts`). An update counts the agent's transcript events per
  session and its cron jobs, takes a cold pre-update backup, recreates the container on
  the newer version (`lib/agent-recreate.ts`, argv only, env values outside the process
  table), waits for `/startupz` to report that version, re-applies Rev4a's config and
  checks the counts. A rollback restores the pre-update backup on the previous version.
  Both run inside the Rev4a process; `markInterruptedUpdates()` at startup turns an
  unfinished one into `interrupted`. `lib/agent-busy.ts` gives the routes one 409 reason
  for "edit, update, recreate, restore or backup running". After a successful update, `pruneAgentImages()`
  keeps only images in use plus the newest and previous versions.
- **Agent recreates** are `lib/agent-recreate.ts`, with their state in the
  `agent_recreates` table (`lib/agent-recreate-state.ts`): the same-version counterpart
  of an update. A cold backup, then the container rebuilt on the image the agent already
  runs, then `/startupz`, then the runtime config. It answers `202` and runs in the
  background, so a page reload or a Rev4a restart does not lose it; at startup a job
  still active becomes `interrupted` and the agent is started again — after its backup
  helper has finished, never while the archive is written. On success the older
  `prerecreate` archives are pruned to the newest two. The same `recreateAgentContainer()`
  serves the edit route (`PATCH` → 202, no backup) and the Update action.
  `agentBusyReason()` (`lib/agent-busy.ts`) covers it for every route that changes an agent.
- **Host ports** have one source of truth: `lib/agent-ports.ts` holds the pure rules
  (`validatePortInput`, `findAvailablePortBlock`, `portMappingArgs`,
  `hostPortsFromBindings`, `hostPortsFromArgs`) and `lib/agent-ports-server.ts` answers
  which ports are taken (`getHostPortHolders()`, `getUsedHostPorts()`; server-only, it
  talks to the Docker socket). Creation, the create form, the edit flow and every
  container rebuild (update, recreate, rollback) read their numbers from there. One block
  maps to the container's gateway port 3000 (`3700-3709` → `3700-3709:3000-3009`); all
  flows produce the same validation messages, and a flow rebuilding a container excludes
  that container's own ports, so its block never conflicts with itself.
  **A stopped container still holds its block**, but neither `docker ps -a --format
  '{{.Ports}}'` nor the Docker API's container list reports its ports (verified on Docker
  29: both return nothing). The lookup therefore reads each container's
  `HostConfig.PortBindings` — the only source covering the stopped ones. Without that, a
  new agent could be handed the block of a stopped agent, and the clash only surfaced
  later, when that agent was started again (`Bind for 0.0.0.0:3730 failed: port is
  already allocated`), after the container it was replacing had been removed.
  `recreateAgentContainer()` refuses such a clash **before** removing anything, naming the
  container that holds each port, so the agent stays up and the operator changes the range
  from the Edit panel; a failed `docker run` no longer leaves a container behind.
  The two forms validate a range **as it is typed** against that same set — the create
  wizard through its page prop plus `GET /api/agents/ports`, the Edit panel through the
  endpoint when it opens — so both show the same message and disable their action while
  the range is refused, instead of letting the server refuse it on submit.
- **Agent edits** are `lib/agent-edit.ts`, with their state in the `agent_edits` table
  (`lib/agent-edit-state.ts`): the display name (`AGENT_NAME`) and/or the port range are
  applied by rebuilding the container on the image it already runs — **no backup**, the
  volume is never touched. Same 202-and-background shape as a restore; the parameters
  live in the row, so recovery can tell what was being applied. The panel shows a banner
  and the agent card an `EDITING` chip.
- **Agent restores** are `lib/agent-restore.ts`, with their state in the `agent_restores`
  table (`lib/agent-restore-state.ts`): the archive replaces the volume (stop, clear,
  extract, start), up to 30 minutes. Same 202-and-background shape as a recreate, and the
  same guarantees — a reload or a Rev4a restart does not lose the job, a second restore
  is refused, and an interrupted one is **run again from the same archive** at startup: a
  half-written volume must never be presented as a restore, and the archive was already
  checked before the job started (when it is gone the container is started on whatever the
  volume holds, and the row says so). The extract has no percentage (it is a single
  `tar xzf`); the panel and the agent card show `RESTORING`.
- **The four job tables share one implementation**: `lib/agent-job-state.ts` builds the
  insert/update/latest/active/`markInterrupted` machinery for `agent_upgrades`,
  `agent_recreates`, `agent_restores` and `agent_edits`; each `lib/agent-*-state.ts` keeps
  only its table's types and function names. They were four near-identical copies that had
  started to drift. At startup `lib/agent-jobs-maintenance.ts` prunes each table to the
  newest 20 rows per agent — the panel reads the latest row only, so the rest is history.
- **Browser access** to an agent's Control UI goes through `lib/agent-devices.ts`:
  `openclaw devices list | approve | reject | rename | remove` and
  `openclaw dashboard --json`, run inside the container with the async `dockerExec`.
  The gateway token is resolved inside the container (`/root/.agent-token`, then its
  environment), never passed in argv. Every supported OpenClaw answers `/startupz` with
  JSON and always requires approval; when that read fails the panel says it could not
  tell, instead of guessing.
  `buildInviteLink()` builds the plain token link for someone else; the invite route
   refuses agents without approval. Every link's token is read inside the container,
   and its host is the request's `Host` header (`hostnameFromHostHeader()`), never a
   caller-supplied value.
- **Telegram DM pairing** lives in `lib/channelManager.ts`. The bot binding is config
  (`channels.telegram.botToken`/`dmPolicy`); *who* may talk is OpenClaw's pairing
  store — on 2026.9.3 the SQLite rows in `~/.openclaw/state/openclaw.sqlite`, not the
  `credentials/*.json` files older releases used. Reading and revoking go through the
  store's own functions (`readChannelAllowFromStoreSync`,
  `removeChannelAllowFromStoreEntry`): no CLI, RPC or documented export exposes them,
  so a small script run inside the container finds OpenClaw's `pairing-store` module by
  glob and its functions by name (the names survive minification; no hash or minified
  symbol is hardcoded) and calls them, which uses the same state transaction the CLI
  does. If a release stops exposing the store, the revoke fails with a message pointing
  at `/allowlist remove` — it never reports success without changing anything. Approving
  a pairing request (`openclaw pairing approve`) also bootstraps
  `commands.ownerAllowFrom` for the first owner (OpenClaw's own behaviour).

**Running commands inside containers** (`lib/docker-exec.ts`):

This module is how a route reaches an agent container. The migration to it is
not finished — routes predating it still shell out directly — so treat these as
the rules for anything you touch, not as a description of the whole tree:

- **Never `execSync`/`execFileSync` in a request path.** They block Node's single
  thread: while one runs, no other request is served and no agent's stream
  advances. A `docker exec` costs ~90 ms warm and the OpenClaw CLI costs
  seconds, so a route that walks the fleet freezes the event loop for the sum of
  all of them. Use `dockerExec` / `dockerExecShell` and their `…NoFail` variants.
- **`mapWithConcurrency` is fail-fast, like `Promise.all`.** If the mapped
  function rejects for one item, the whole call rejects and results already
  computed for other containers are discarded. Fanning out over a fleet requires
  the `…NoFail` variants, or an explicit per-item try/catch, so one unreachable
  container cannot blank an entire page. Callers: `app/api/skills/route.js`,
  `app/api/agents/models-summary/route.ts`,
  `app/api/agents/channels-summary/route.ts`,
  `app/api/agents/devices-summary/route.ts`,
  `lib/openclaw-cron.ts`, `app/api/credentials/detect/route.ts`,
  `lib/credentials/delivery.ts`.
- **Never interpolate a secret into a command string.** Pass it through the `env`
  option and reference it as `"$KEY"`; command substitution inside an
  interpolated value would otherwise execute on the host. Only the *name* reaches
  argv, as `docker exec -e KEY` — docker forwards the value from its own
  environment, so it appears neither in the host process table nor in any
  rejection built from that argv.
- **A timeout does not reject.** `docker exec` exits 0 on the SIGTERM Node sends
  when the deadline passes, so a command killed halfway *resolves* with whatever
  it had already printed. A `try/catch` therefore cannot tell a truncated read
  from a complete one. Where that distinction matters, make the script prove it
  finished — `detect.ts` emits a `probe:complete` sentinel before its slow calls,
  `containerRead` prints a terminator after the file — and treat its absence as
  failure. Anything that writes back what it read must refuse to write when the
  proof is missing.
- **A rejection carries `stderr`, never the command.** Node's own message is
  `Command failed: <argv…>`, which reproduces whatever was interpolated into the
  script. `dockerExec` replaces it with `docker exec <container>: <cause> —
  <stderr>`, because these messages travel: `syncProfileToAgents` puts one into
  `SyncResult.error` and the sync route returns it to the browser.

`dockerExecWithInput` uses `spawn` rather than `execFile` because
`promisify(exec)` silently ignores an `input` option: the process starts, stdin
is never written, and the command hangs with no error to point at.

- **The process model and self-update.** `rev4a serve` (the systemd unit's process) is a
  supervisor: it spawns `rev4a _run <port>`, which in turn runs Next, the daemon and the
  terminal WebSocket. `rev4a update` installs the new version, then `rev4a restart` writes
  `.restart-flag` in the data directory; `_run` sees it, stops its children, waits for the
  port to come free and exits with code **42**, and the supervisor relaunches `_run` on the
  new code — so the supervisor itself never goes down (the unit's `NRestarts` stays 0).
  The dashboard's **Update now** is only a detached `rev4a update` (`POST
  /api/update-check`): it must not try to restart anything itself, because the update
  stops the very process that spawned it, and the CLI's own flag is the mechanism that
  matters. Its output goes to `update.log` in the data directory, since nothing else can
  report the outcome: the banner records what it asked for, waits for the installed
  version to change and only then reloads (see `VersionBanner`).

### 3.2 Agent Container Template (`openclaw-agent-base`)

Docker image for every agent container.

**Contents:** See the live Dockerfile at
`agent-templates/base-image/Dockerfile` (authoritative source).
The image installs `openclaw`, `vercel`, `trello-cli`, `gh`, `supabase`,
copies the entrypoint script, and applies baseline gateway config patches.


**Volume mounts (per agent):**
```
~/.config/rev4a/shared/shared-skills  → /data/.openclaw/shared-skills    (ro)
~/.config/rev4a/shared/rev4a-rules    → /root/.openclaw/workspace/.rev4a  (ro)
agent-{name}-data (named vol)         → /root                             (rw, per-agent persistent state)
```

All shared volumes are defined centrally in `lib/agent-setup.ts`
(`REV4A_VOLUMES`) and used by both the create and recreate API routes.
The `bootstrap-extra-files` hook is pre-wired in the base image Dockerfile
and guaranteed at runtime by `applyRuntimeConfig()`, which also applies the Control
UI browser-origin policy (`withControlUiPolicy()`): the Host-header fallback on, an
`allowedOrigins: ["*"]` list and the retired `dangerouslyDisableDeviceAuth` removed.

**Injected environment variables:**
```
AGENT_NAME=<agent-name>
AGENT_TEMPLATE=<template>
OPENCLAW_GATEWAY_TOKEN=<shared agent token>
TZ=Europe/Rome
```

> **Note:** Provider API keys are never injected into agent containers. Agents use the Rev4a provider gateway at `http://host.docker.internal:3740/api/provider/v1` (resolved via `detectProviderGatewayUrl()`).

### 3.3 AI Provider Gateway (implemented)

The Provider Gateway is fully implemented and operational. Agent containers
point to the Rev4a provider proxy instead of using direct API keys.

**Flow:**

```
Agent Container          Rev4a Gateway              Provider API
     │                         │                         │
     │ Authorization: Bearer <gateway-token>             │
     │ POST /api/provider/v1/chat/completions            │
     │ model: rev4a/deepseek-flash                     │
     │────────────────────────>│                         │
     │                         │ POST /v1/chat/completions│
     │                         │ Authorization: Bearer <real-key>
     │                         │────────────────────────>│
     │                         │       response          │
     │                         │<────────────────────────│
     │       response          │                         │
     │<────────────────────────│                         │
```

**Key characteristics:**

- The Rev4a server in `app/api/provider/v1/` acts as an OpenAI-compatible proxy
- Authentication uses `data/provider-keys.json` — the Bearer token must match
  the 'rev4a' entry
- Model lists (`GET /api/provider/v1/models`) return an empty list on invalid
  or missing token, preventing information leakage
- Chat requests (`POST /api/provider/v1/chat/completions`) return 401 on
  invalid or missing token
- API keys live only on the Rev4a server (in `data/provider-keys.json`),
  never inside agent containers
- The Gateway page (`/gateway`) provides a UI to manage provider keys and
  sync them to agent containers via `PUT /api/gateway/provider`

See [GATEWAY.md](dev/GATEWAY.md) and [PROVIDERS.md](dev/PROVIDERS.md) for
detailed documentation.

---

## 4. Credential Management (Vault)

Two separate stores:

- **Provider API keys** — `<data dir>/data/provider-keys.json`, used by the Rev4a
  provider proxy.
- **Third-party service credentials** — `<data dir>/data/credentials.db` (SQLite),
  managed from the Credentials page. Five providers: `github-pat`, `trello`,
  `vercel`, `supabase`, `notion` (`lib/credentials/providers.ts`).

**Secrets are stored unencrypted.** `credential_secrets.payload` holds raw JSON.
Anything able to read that file, or to reach `POST /api/credentials/[id]/reveal`
with a valid session, obtains them in the clear. Encryption (AES-256-GCM, or an
external vault) is not implemented.

**Delivery is explicit, not automatic.** Creating an agent installs nothing: a
credential reaches a container only when the user syncs it
(`POST /api/credentials/[id]/sync`), and leaves only on de-sync
(`DELETE /api/credentials/[id]/sync`). There is no per-agent permission model —
any stored credential can be synced to any container. Delivery writes each CLI's
own config inside the container (`lib/credentials/delivery.ts`); OpenClaw's
`secrets` subsystem covers only OpenClaw's own configuration credentials and
offers nothing for third-party CLIs.

`GET /api/credentials/detect` reports which credentials are actually installed,
by SHA-256 hashing the token found in each container and matching it against the
stored profiles.

**Planned:** encryption at rest, and a per-agent permission model so a credential
can be restricted to a subset of agents.

---

## 5. Lifecycle Orchestration

### Agent spawn flow

```
Rev4a Dashboard UI
       │
       │ Click "New Agent"
       ▼
┌──────────────────────────────────────┐
│ 1. Template selection                │
│    - Choose template (argus/atlas/…) │
│    - Configure model, workspace, etc │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 2. Rev4a generates OpenClaw config │
│    - Takes template                  │
│    - Injects providers from vault    │
│    - Injects service tokens          │
│    - Writes to /docker/shared-config │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 3. Rev4a spawns Docker container   │
│    - docker run openclaw-agent-base     │
│    - Env vars + volumes              │
│    - network: rev4a-net            │
│    - CPU/RAM limits                  │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 4. Container self-configures         │
│    - Reads config from shared-config │
│    - Runs healthcheck                │
│    - Registers on Rev4a API        │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 5. Agent ONLINE                      │
│    - Appears on dashboard            │
│    - Ready to receive tasks          │
└──────────────────────────────────────┘
```

### Implemented API endpoints

```
POST   /api/agents/create          Create new container agent (template + model)
DELETE /api/agents/{id}            Destructive: remove container + volume + backups
POST   /api/agents/{id}/restart    Restart container
POST   /api/agents/{id}/recreate   Rebuild on the agent's own version (volume preserved)
GET    /api/agents                 List all agents (Docker containers with AGENT_ID)
```

---

## 6. Shared Volumes

### Shared Skills (`~/.config/rev4a/shared/shared-skills`)
```
~/.config/rev4a/shared/shared-skills/
  my-custom-skill/    # promoted from an agent workspace
    SKILL.md
  another-skill/
    SKILL.md
```

Skills are stored in a flat structure (no subcategory folders like `core/`, `ops/`, `dev/`).
This keeps the layout simple and avoids hierarchy debates at this stage.
**Permissions:**
- Rev4a host: rw (writes during promote, reads for listing)
- Agent containers: ro (mounted at `/data/.openclaw/shared-skills`)
- Owner: uid 1000 (node), group: 1000, mode: 2775 (setgid)

**Auto-configuration:**
- The agent base image (`openclaw-agent-base`) pre-configures `skills.load.extraDirs: ["/data/.openclaw/shared-skills"]` so every new agent discovers shared skills automatically.
- Both create and recreate routes guarantee this via `applyRuntimeConfig()` from `lib/agent-setup.ts`.
- No manual setup: `rev4a serve` creates both shared directories during
  preflight (`ensureRev4aRules()` in `bin/rev4a.js`). They live under
  `REV4A_DATA`, so a plain `mkdir` suffices — no `sudo`, no permission
  bits to set.

> These directories used to live at `/docker/shared-skills` and
> `/docker/rev4a-rules`, which needed `sudo` on Linux and could not exist at
> all on macOS — the root volume is a sealed APFS system volume, so `/docker`
> is not creatable even as root, and agent creation failed with
> `mounts denied`. Being under the user's home also puts them inside the
> directories Docker Desktop shares with its Linux VM by default, so bind
> mounts work with no extra configuration.
>
> Upgrading an existing install: move any promoted skills from
> `/docker/shared-skills` into the new location, then hit **Recreate** on each
> agent so its container picks up the new mount source. Containers freeze
> their mounts at creation time, so running agents keep using the old path
> until recreated. `rev4a-rules/AGENTS.md` needs no migration — it is
> regenerated from the package on every start.

### Rev4a System Rules (`rev4a-rules/`)

Versioned in the repo at `rev4a-rules/AGENTS.md`. Deployed to
`~/.config/rev4a/shared/rev4a-rules/` on every `rev4a serve` startup via
`ensureRev4aRules()` in `bin/rev4a.js`. Mounted read-only into every
agent container and injected into sessions through the
`bootstrap-extra-files` hook (glob `.rev4a/*.md`).

All shared volumes are defined in `lib/agent-setup.ts` — a single source
of truth used by both create and recreate API routes.

### Shared Repositories (`/docker/shared-repos`)
```
/docker/shared-repos/
  rev4a/     # the Rev4a repo
  projects/    # project repos for agents to work on
```
**Permissions:** rw for Rev4a and agents that need to write code.

---

## 7. Networking

All containers on the same Docker bridge network:

```yaml
networks:
  rev4a-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

**Communication:**
- Agent → Rev4a Gateway: `http://rev4a-control:3721`
- Agent → Rev4a Dashboard: `http://rev4a-control:3720`
- Rev4a → Agent (healthcheck): `http://agent-{id}:3000`
- Browser → Agent Control UI: the container's published host port, `http://<host>:<port>`. Rev4a sets no reverse-proxy labels

---

## 8. Daemon & Data Pipeline

The Rev4a daemon (`daemon.js`) is a standalone Node.js process that bridges the OpenClaw runtime and the SQLite database. It is not part of the Next.js server.

### Responsibilities

1. Poll `openclaw sessions --json --all-agents` every 30 s
2. Upsert session rows into `events.db`
3. Emit `spawn` / `complete` / `fail` / `spawn_timeout` events into the `events` table
4. Sample the host machine (CPU, RAM, swap, storage) every 30 s into `metrics.db`, on a
   timer of its own
5. Sample what each container consumes every 60 s, and the disk Docker holds every 10 min,
   into `metrics.db` (see [Container Consumption](#container-consumption))
6. Detect anomalies (CPU > 85%, RAM > 90%, a disk at 90%) and record them as events
7. Read what each running agent spent, as its own OpenClaw priced it, every 5 min into
   `costs.db`, and each vendor's balance or usage every hour (see [Agent Costs](#agent-costs))
8. Manage DB lifecycle (WAL mode; events.db checkpointed after each poll cycle)

### Poll Interval

A fixed 30 s timer, whether or not sessions are working. When the OpenClaw CLI is not on
the host, the session poll logs it once and stays idle; the machine metrics keep being
sampled, since they have their own timer.

### Session costs

The session poll writes no cost: `sessions.cost_usd` stays 0. It used to be estimated from a
fixed 2025 rate table (`$3 / $15` per 1M for anything unknown), which the dashboard showed as
spend. What the agents actually spend is priced by each agent's own OpenClaw and read by the
Agent Costs timer — see [Agent Costs](#agent-costs).

### Upsert Logic

The daemon uses `INSERT … ON CONFLICT DO UPDATE` with these rules:

- `updated_at` is only refreshed when tokens or status actually change (avoids phantom updates)
- `parent_id` is updated only if the incoming value is better (non-null, and current is null or a generic `:main` default)
- `label` is updated only if the current value is null or still the raw session key (preserves declared names)
- `ended_at` is set once and never overwritten with null
- `trello_card_url` is set from `task_preview` on first occurrence; never overwritten

### System Metrics

Every 30 s (`METRICS_INTERVAL_MS`) the daemon samples the machine it runs on and writes a
`system_metrics` row plus one `system_disks` row per filesystem into `metrics.db` — its
own database next to `events.db` (schema in `docs/dev/DATABASE.md`). Machine-wide sources:

- **CPU**: busy share of all cores since the previous sample, from host ticks
  (`os.cpus()`, i.e. `/proc/stat` on Linux) — the whole machine, not Rev4a's cgroup
- **RAM / swap**: `/proc/meminfo` on Linux, used = `MemTotal − MemAvailable` (what `free`
  shows); on macOS (development) active + wired + compressed pages from `vm_stat` and
  `vm.swapusage`; elsewhere `os.totalmem()` / `os.freemem()` and no swap
- **Storage**: `fs.statfsSync()` on `/`, Docker's data root (`docker info`, asked once and
  retried every 10 min while Docker is down) and Rev4a's data directory, each device once;
  a path that cannot be read (Docker Desktop's root inside its VM) is skipped
- **Load**: `os.loadavg()` 1 / 5 / 15 min

The first sample comes about 5 s after start (the CPU figure needs a delta from the baseline
taken at load), then one every 30 s. Samples older than 30 days are pruned at every sample.
`metrics.db` is opened in a try: if it cannot be (corrupt, unwritable), sampling is off —
`[METRICS] disabled` in the log — and the session poll keeps running. The API side reads
it through `lib/metrics-db.ts` (read-only, `null` when there is nothing to read);
`GET /api/metrics` serves the System page (`/system`) and the dashboard's Machine card.

### Container Consumption

The System page says *that* the machine is busy; this says *who*. On a timer of its own the
daemon reads every running container from the Docker Engine API — `GET /containers/{id}/stats?stream=false&one-shot=true`,
10–20 ms a container, where `docker stats --no-stream` waits a second each and returns formatted
strings — and writes `container_metrics` into `metrics.db` (schema in `docs/dev/DATABASE.md`):

- **CPU** from the cumulative CPU time (ns): the difference between two samples over the
  elapsed time, in cores; the first sample after a start only primes the counters. A counter
  that goes backwards (the container restarted) gives no figure for that sample, never a spike.
- **Memory** is the working set — usage minus the inactive page cache (`inactive_file` on
  cgroup v2, `total_inactive_file` on v1), what `docker stats` shows.
- **Processes, network and block I/O** as gauges and per-second rates. A container that stops
  leaves a gap; one that is gone takes its counters with it.
- **Names:** an agent's `AGENT_NAME` (read once per container id from its inspect), else the
  container's name. Every running container is sampled — agents, and the rest as "container".
- **Docker's disk** (`/system/df`, every 10 min): each named volume — which gives each agent's
  storage, through the volume names its mounts list —, each writable layer, the images and the
  build cache with what no container/build uses. Sizes and "unused" are readings, not advice.
- The shares need Docker's own cores and memory (`/info`, re-read every 10 min): on Docker
  Desktop those are its VM's (8 GB of a 16 GB Mac), on the VPS the machine's.

The socket path rules (env, `/var/run`, Docker Desktop's `~/.docker/run`, `docker context`) live
once, in `lib/docker-socket-path.js`, required by both the daemon and `lib/docker-socket.ts`. A
Docker that is down is logged once and recovered from by itself; a failed disk reading leaves the
previous one in place. `lib/container-metrics.ts` reads it all for `GET /api/metrics/containers`
(the System page's *Agents and containers* section, the agent panel's RESOURCES, the Containers
page). Anomalies per container (processes, sustained memory) are not raised yet.

### Agent Costs

Rev4a computes no cost. Every model in the `rev4a` provider block synced into the agents
carries its price (`cost`, from `model-pricing.json` through `priceAt()`), so each agent's
OpenClaw prices every call itself — per call, session and day, cache split out. A vendor
priced by time of day (DeepSeek off-peak) is re-synced at each change of band by
`lib/price-schedule-sync.ts`, started from `instrumentation.ts`; OpenClaw keeps the cost
recorded at call time. Details in `docs/dev/GATEWAY.md` (Costs).

Every 5 min (first pass 20 s after start) the daemon first wakes every running agent with one
short call — OpenClaw rebuilds its transcript index in about a minute after a restart or a
price change, and woken together the agents rebuild in parallel — then asks each, one at a
time, for its figures over the last 30 UTC days — `usage.cost` and
`sessions.usage` through `docker exec … openclaw gateway call` on the agent's port 3000,
the token resolved inside the container — and rewrites that window in `costs.db` (schema
in `docs/dev/DATABASE.md`). An answer from an index OpenClaw is still rebuilding is never
stored. The readers — `GET /api/costs/usage` (the Costs page, `/costs`), `GET /api/costs` and
the SSE stream (the dashboard), the system-health cost check, and `GET /api/costs/agent` (the
agent panel) — share one read-only handle (`lib/costs-db.ts`) and one set of spend queries
(`lib/agent-costs.ts`); the vendor readings are read by `lib/cost-reconciliation.ts`.

After a pass, at most once an hour, the daemon also reads each vendor's own figure —
DeepSeek's balance, OpenRouter's lifetime usage (read-only calls, never billed) — and stores
it next to the agents' cumulative priced total for that vendor's models, in the same row
(`vendor_balance`). Between two rows, what the vendor billed and what the agents priced
cover the same interval: the Costs page's *Against the bill* (`lib/cost-reconciliation.ts`).
`costs.db` is opened in a try: if it cannot be, collection is off (`[COSTS] disabled`).

### Anomaly Detection

After each sample the daemon inserts a `system_anomaly` event into `events.db`
(`{ metric, values, threshold, message }`) and logs `[ANOMALY] <message>` when:

| Metric | Condition | Repeats |
|---|---|---|
| CPU | > 85% on two consecutive samples | at most once per 5 min |
| RAM | > 90% on two consecutive samples | at most once per 5 min |
| Disk (each filesystem) | ≥ 90% | once when it reaches it, no cooldown — again only after it drops back under, or after the daemon restarts |

No feature consumes `system_anomaly` events yet; they only pass through the generic
event feeds.

### DB Safety

- WAL mode + `PRAGMA synchronous = NORMAL` for concurrent read safety
- `PRAGMA wal_checkpoint(PASSIVE)` runs after each poll cycle, `FULL` every 10 cycles
- On `uncaughtException` the daemon logs but does NOT exit — relies on systemd Restart=always for recovery

### Migrations

The daemon applies these migrations at startup if columns don't exist:

```sql
ALTER TABLE sessions ADD COLUMN trello_card_url TEXT;
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;
```

---

## 9. Migration Plan

### Phase 0 — Preparation (✅ Done)
- [x] Architecture document exists
- [x] Rev4a code is in the workspace
- [x] Git repository on `github.com/Flame0510/rev4a.git`
- [x] VPS-specific changes merged into `main` branch

### Phase 1 — Container separation
- [x] `openclaw-atlas` running as standalone container
- [ ] Create `openclaw-agent-base` Docker image and push to registry
- [ ] Define shared volume structure
- [ ] Test cross-container communication

### Phase 2 — Provider Gateway
- [x] Implement proxy API on Rev4a (`/api/provider/v1/`)
- [x] Gateway Page (`/gateway`) for provider key management
- [x] Agent model configuration in the agent detail panel
- [x] Provider sync to agent containers (`PUT /api/gateway/provider`)
- [x] Auth via rev4a token in `data/provider-keys.json`
- [ ] Rate limiting per agent
- [ ] Transparent provider switching (change keys in one place)

### Phase 3 — Full agent extraction
- [ ] Move Prometheus to its own container
- [ ] Move Argus to its own container
- [ ] Rev4a becomes pure orchestrator (no agent sessions)

### Phase 4 — Alternative runtimes
- [ ] Test Hermes in a dedicated container
- [ ] Test OpenCode in a dedicated container
- [ ] Unified dashboard for all runtime types

### Phase 5 — Automation
- [ ] `rev4a agents spawn` CLI command
- [ ] Auto-scaling? (spawn more agents under load)
- [ ] Automated vault + config backups

---

## 10. Open Questions

1. **Provider Gateway: custom proxy or existing product?**
   - Option A: Homemade proxy (Node.js, lightweight, integrated in Rev4a)
   - Option B: LiteLLM / Portkey (more features, heavier)
   - Recommendation: start with homemade (A) — Rev4a is already Node.js

2. **Memory: centralized or distributed?**
   - Centralized: simpler, single DB, single point of contention
   - Distributed: per-agent memory, Rev4a indexes centrally — more resilient
   - Recommendation: distributed with central index

3. **External access to agents** — decided: each agent's Control UI is published on a
   host port, and Rev4a sets no reverse-proxy labels. HTTPS or a domain means the
   operator's own proxy in front of that port. A first-class integration, with routing
   labels applied at `docker run`, would be a separate feature.

4. **Hermes and other frameworks: dashboard integration?**
   - Hermes has its own session format
   - Rev4a daemon should have "adapters" for different runtimes
   - Or Hermes exposes an API compatible with OpenClaw format

5. **Resource calc: enough for 3-4 agent containers?**
   - Estimate: 1 Rev4a (~500 MB) + 3 agents (~2 GB each) = 6.5 GB RAM
   - CPU: with limits, 3-4 agents should run fine
   - Monitor: if saturated, consider VPS upgrade

---

## 11. Container Terminal

Rev4a provides a real, interactive terminal (xterm.js in the browser, a PTY via
`node-pty` on the host) for any running container. Details in
[docs/CONTAINER-TERMINAL.md](CONTAINER-TERMINAL.md).

| Process | Port | Role |
|---|---|---|
| `server.js` | 3740 | Next.js (pages, API) plus the WebSocket upgrade on `/api/terminal-ws` |
| `terminal-ws-server.js` | 3741 (127.0.0.1) | The PTYs and their sessions |

Both are started by `rev4a serve`. The browser opens the terminal on the dashboard's own
port, so no reverse proxy is needed. `server.js` checks the session cookie, the Origin and
the container name, then forwards the handshake with a per-boot secret the terminal server
requires; the terminal server is a process of its own so heavy shell output never stalls
the dashboard. A shell survives a dropped connection for 2 minutes and is resumed by the
same session id.

## 12. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Orchestrator | Docker / Docker Compose | Already in use |
| Dashboard | Next.js 16 + React 19 | Current Rev4a, served by `server.js` (Next's programmatic API) |
| Container terminal | xterm.js 6 (browser) + node-pty + `ws` | `docker exec` PTYs, sessions resumable for 2 minutes — `docs/CONTAINER-TERMINAL.md` |
| Provider Gateway | Express/Fastify (Node.js) | To implement in Rev4a |
| Database | SQLite (WAL mode) | Current `events.db`, may need to scale |
| Memory | Per-agent SQLite + central index | New |
| Config | Generated YAML/JSON | New |
| Credential stores | SQLite + JSON | credentials.db for service tokens, provider-keys.json for provider API keys. Neither is encrypted |
| Reverse proxy | Optional, operator's choice | Rev4a sets no reverse-proxy labels on agent containers |
| Monitoring | Rev4a daemon (extended) | Evolution of current daemon |
| Version control | Git + GitHub | `github.com/Flame0510/rev4a.git` |
