# Rev4a Architecture — Design & Vision

> **Status:** Active — `main` branch
> **Last updated:** 2026-11-09
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

**Credentials vault:** The `/credentials` page stores third-party service tokens in `credentials.db` and delivers them to the agents they are switched on for, through OpenClaw's secret store and skill config. Provider API keys live separately in `provider-keys.json`, managed from the Gateway UI.

**Container management UI:** The `/containers` page lists all Docker containers, running or stopped, with status, image, IP and ports, and opens a web terminal into any running one. Fully functional. Each running container's CPU, memory and processes are on its row, with a link to its charts on `/system`, which also shows the machine's CPU, RAM and disk.

**Workspace API:** File tree explorer and editor for the agent containers with real-time reads (no caching), via `docker exec` with argv arrays (no host shell). Paths are confined to `/root/.openclaw/workspace` after `..` and symlinks, saves are atomic and exact, errors carry real HTTP statuses. The pure helpers (id and path checks, argv builders, the save script, parsers) are `lib/workspace-fs.ts`. The host ("Local") workspace is gone and `REV4A_WORKSPACE_ROOT` is ignored.

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

### Dashboard framing protection

`next.config.mjs` applies `X-Frame-Options: SAMEORIGIN` to `/:path*`, covering
dashboard pages and API responses. Same-origin framing remains available for the
Workspace PDF preview. The workspace SVG response keeps its existing sandbox CSP.

Next.js 16.2.6's `sendResponse` keeps an already configured CSP and skips a route's
CSP, rather than combining the policies. A global framing-only CSP would therefore
discard the SVG sandbox; CSP changes must preserve that route policy. This behavior
was verified offline with Next's response sender, without opening a listener.

`node scripts/test-security-headers.mjs` checks the configured header rule and the
npm package's test/fixture exclusions without a running server or an npm subprocess.

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
  session store and wants `doctor --fix` — answers 200 on `/health` while draining, so
  `/health` is never accepted as "ready": it would let callers configure an agent that
  is still migrating. Do not reimplement the wait in
  a route. The single attempt is `probeGateway()` (`ready` = 200 + `started`; `starting` = 503; `no_answer` = no HTTP code at all: refused, timeout, truncated; `unexpected` = any other HTTP answer, such as a 200 without `started` or a 404; `error` = the `docker exec` itself failed; the wait treats everything but `ready` as "not yet"), the one
  place the `/startupz` rule lives; `waitForGatewayReady()` polls it, `GET /api/agents/gateway`
  (`lib/gateway-status.ts`) calls it once per running container for the Agents page (async, at most 4 probes at a time), and
  `open-control-ui` calls it once before redirecting and refuses only on a real 503 inside the budget (`blocksOpen()`), never for a container with `RestartCount > 0`. `lib/gateway-status.ts` keeps a
  module-level cache keyed by container id and `StartedAt`: `ready` for 60 s, `starting` or no
  answer for 2 s, `error` never, one shared in-flight probe per container. `lib/gateway-state.ts` is the pure
  decision (`stopped` / `starting` / `ready` / `not_ready` / `unknown`; `starting` for a 503 or no answer, `not_ready` after 10 minutes, `unknown` for `unexpected` and `error`). The 10 minutes count from a per-container anchor (`nextStartAnchor()`, memory only), not from Docker's `StartedAt`, which every restart-policy restart resets: it moves only on a manual restart or start (the restart count drops, or is 0 with a new start time) and is cleared when the Gateway is ready, so a crash loop ends in `not_ready`. A container Docker lists as `restarting` is not probed and counts as running with `no_answer`. After a Rev4a restart a container with `RestartCount` 0 is anchored at its `StartedAt` again (same clock); a policy-restarted one gets a new 10 minutes. A loop whose Gateway is ready for a moment in each run clears the anchor every time and never reaches `not_ready` (known limit). The page and the route block Open in the same cases: a 503 inside the budget, `RestartCount` 0, a readable start time.
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
  lets a rollback pull its image: a rollback whose target
  is no longer listed is refused up front (`startAgentRollback()`) instead of restoring a
  volume on a version this build cannot run. `lib/agent-images.ts`
  lists local `openclaw-agent-base:<version>` images through the Docker API, reads an
  agent's version (image label or tag, else `openclaw --version` in the container, cached
  per image id), reads the registry tag list over HTTP (cached 10 min), pulls a version
  and resolves the image a recreate uses. Images are never addressed as `:latest`: create
  takes the newest supported version downloaded, recreate the agent's own.
- **Cold backups** are `lib/cold-backup.ts`. The agent is stopped and a detached helper
  container, `rev4a-backup-<id>` from the agent's own image, archives its volume to
  `<REV4A_DATA>/backups` (bind-mounted at `/backup`) as `.partial`, reads it back and renames it,
  gives it to Rev4a's user (`OWNER=uid:gid`, mode 600); the agent is started
  again if it was running. The helper and its labels are the job, so no request waits
  on it and a Rev4a restart does not lose it (`reconcileColdBackups()` in
  `instrumentation.ts`). While a helper runs, the routes that change the agent answer
  409 (`isColdBackupRunning()`), and `syncAllAgents()` skips the agent.
- **Agent backups are plain files** (`lib/backups.ts`, `lib/backups-volume.ts`): `BACKUPS_DIR` is
  `<REV4A_DATA>/backups` (0700, created by `ensurePaths()` / `ensureHostDirs()`). Listing, size/mtime,
  existence, deletion and the pre-recreate pruning are `fs` calls on validated names (no request path, symlinks
  neither listed nor followed); a helper container is used only to write an archive, to restore one, and as the
  fallback to delete a file `fs` may not (root-owned, from an older helper). Older releases kept them in the
  Docker volume `rev4a-backups`; `lib/backups-migration.ts` (planner, resumable runner) and
  `lib/backups-migration-host.ts` (real dependencies) move them at startup, in the background, one verified
  file at a time (copy to `<name>.migrating`, `tar -tzf`, rename, chown/chmod, delete from the volume),
  and remove the volume when it is empty and unused. While it runs, listings merge the folder and the volume
  (the folder wins), and existence checks, restore and rollback read from wherever the file is.
  A file whose copy does not verify is skipped (kept in the volume, named in the status) and the larger ones
  still move; after "Docker did not answer" the migration retries every 5 minutes. `lib/backups-names.ts` is the
  one parser of a backup name (`agent-<id>-<kind>-<timestamp>.tar.gz`, anchored from the right) because agent ids
  may contain `-`: every selection of an agent's backups compares the parsed id, never a `agent-<id>-` prefix.
  The write helper first checks it can write to the mounted folder and says so when it cannot (SELinux,
  user-namespace remapping).
- **Agent updates** are `lib/agent-update.ts`, with their state in the `agent_upgrades`
  table (`lib/agent-update-state.ts`). An update counts the agent's transcript events per
  session and its complete cron identity/ownership inventory, takes a cold pre-update backup, recreates the container on
  the newer version (`lib/agent-recreate.ts`, argv only, env values outside the process
  table), waits for `/startupz` to report that version, re-applies Rev4a's config and
  checks the counts. A Gateway that is slow to start (past 10 minutes) is waited for up to 30
  minutes more before the update is called failed (`finishAfterRecreate` in
  `lib/agent-update-resolution.ts`). A `failed` or `interrupted` update is marked resolved
  (`resolved_at`, `resolution`; `status` untouched) only for an update that never produced a verification result (a slow start, or an interruption during `migrating` or `verifying` — never an interrupted rollback), and only with evidence checked now: running, ready,
  on `to_version`, baseline verification passing; at startup (not awaited) and on panel reads (at most
  every 5 minutes per agent). A rollback restores the pre-update backup on the previous version.
  Both run inside the Rev4a process; `markInterruptedUpdates()` at startup turns an
  unfinished one into `interrupted`. `lib/agent-busy.ts` gives the routes one 409 reason
  for "edit, update, recreate, restore or backup running". After a successful update, `pruneAgentImages()`
  keeps only images in use plus the newest and previous versions.
  `lib/agent-update-cron.ts` holds the narrow, tested transition policy: only the upstream-owned
  `skill-collection-review:` retirement on 2026.9.3/2026.9.9 to 2026.10.10 is exempt. User jobs,
  changed owners, unrelated declared jobs and unreadable/partial inventories remain failures.
  Old cron-only failures have a separate background audit using their exact local pre-update
  archive (`lib/backup-cron-evidence.ts`). Original verification/failure fields remain intact;
  unknown ownership stays unresolved and rollback remains available. The same retirement-aware
  dispatcher handles startup and bounded panel retries, including an unavailable-at-startup Gateway.
  After successful verification of a 9.x -> 10.10 Update, `lib/agent-update-cron-account.ts` performs
  best-effort native `cron.update` account adoption only with exactly one connected ChatGPT OAuth
  profile. A model/profile selection captures ownership; restoring the original model (NULL for
  Default) retains ownership and inheritance. Counts/notes live in `cron_account_json`.
  Before the first native mutation, `cron_account_adoptions_by_update` commits the original model and
  temporary selection in Rev4a's DB, keyed by container, update ID and job ID so rollback followed
  by re-upgrade adopts again. Starting an Update atomically marks every unfinished earlier journal
  for that agent superseded (with a completion timestamp so older readers also skip it).
  Adoption runs under the Update's persisted lifecycle claim. Repair considers only the latest
  update's unfinished journal and acquires an exclusive lifecycle claim for that agent; a busy
  agent is skipped until a later retry. Update, rollback, edit, recreate and restore admission check
  that claim in their SQLite transaction. Repair also uses the shared cold-backup and
  in-process ownership checks. Restart clears repair claims without restarting their agents;
  only active update statuses enter interrupted-update container recovery.
  Every pass repairs an unfinished selection before counting
  an already-bound job as finished. Startup and a 60-second background retry repair recorded
  pins, including lost mutation responses, without adopting additional jobs. Fresh native revisions
  and re-read account/model metadata protect operator edits; no OpenClaw DB is written directly.
  Exact journaled pins are repaired even when the CLI-execution route did not create a binding.
  A job counts as associated only after its persisted inference binding to the intended account
  is verified after saving. Routes known before mutation to use CLI execution report
  **no binding needed (model left/restored)** without a binding. An absent binding on other
  routes leaves selection unverified and retries its journaled intent; a rejection stays failed,
  with no repaired count. Agents renders these persisted outcome notes.
  Zero/multiple profiles, existing bindings and native-runtime authority are not reassigned.
- **Agent recreates** are `lib/agent-recreate.ts`, with their state in the
  `agent_recreates` table (`lib/agent-recreate-state.ts`): the same-version counterpart
  of an update. A cold backup, then the container rebuilt on the image the agent already
  runs, then `/startupz`, then the runtime config. It answers `202` and runs in the
  background, so a page reload or a Rev4a restart does not lose it; at startup a job
  still active becomes `interrupted` and the agent is started again — after its backup
  helper has finished, never while the archive is written. On success the older
  `prerecreate` archives are pruned to the newest two. The same `recreateAgentContainer()`
  serves the edit route (`PATCH` → 202, no backup) and the Update action.
  Rebuilt port publications retain each specific `HostIp` from the inspect:
  IPv4 addresses stay explicit, IPv6 addresses use Docker's bracket syntax
  (`[::1]:3701:3001`), and UDP suffixes are preserved. Empty, `0.0.0.0` and `::`
  bindings retain the plain `hostPort:containerPort` form; duplicate wildcard
  families produce one `-p`. Explicit `portArgs` still replace all carried bindings.
  Host-port conflict parsing understands address prefixes before any removal.
  Only the claimed Edit (including removal of a memory limit) and Recreate jobs opt
  into `lib/agent-stop.ts`: verify the original container ID and its `AGENT_ID` label,
  then stop and remove that immutable ID. A missing/mismatched ID refuses the operation.
  The 60 s stop allowance covers normal SIGTERM cleanup without waiting for OpenClaw's
  extended 325 s drain. The stop CLI has a 65 s deadline, each inspection 5 s (both
  inactivity and wall-clock, aborting the HTTP request at the deadline), and removal 15 s: at most 90 s before the rebuild, within
  the background job's budget. Stop failure/timeout, exit 137, or an unconfirmed stop
  emits a lease warning before `rm -f` of that same ID. Edit/Recreate job messages retain
  the warning on success and failure. When Recreate's cold backup has already stopped
  the agent, that existing 30 s stop is its graceful stop; no second stop is issued.
  Recreate observes the backup's exit status/kill fallback and persists a lease warning
  before archiving, including when the backup itself later fails. Only this caller opts
  into observing the backup stop. Update/Rollback, cold backup (30 s stop), Restore,
  Delete and failed-run/create cleanup keep their previous shutdown/removal behavior.
  No lease file is deleted: an existing stale lease must expire, because clearing an
  unproven owner could permit concurrent volume writers.
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
- **Memory limit** (`lib/agent-memory-limit.js`, pure helpers shared with the daemon; `lib/agent-memory-limit-server.ts`): optional and never defaulted. `recreateAgentContainer()` carries `HostConfig.Memory` and `MemorySwap` from the inspect into `docker run` (`--memory`, `--memory-swap`), so no rebuild loses a limit; `opts.memoryLimitMb` overrides it (a number sets it with swap equal, `null` rebuilds without any flag). Setting a limit is `docker update --memory <b> --memory-swap <b>` (live); removal goes through an agent edit with `removeMemoryLimit`, because `docker update` cannot lift a limit. The global default for new agents lives in `agent-defaults.json` (`lib/agent-defaults.ts`).
  Create/Update admission uses shared pure version-specific resource policy plus bounded Docker API
  facts (`lib/agent-resource-policy.js`, `lib/agent-resource-preflight.ts`). Exact 2026.10.10 refuses
  a finite limit below 4096 MiB; 9.3/9.9 retain the operator's cap choice. Unlimited remains unlimited.
  Host planning counts running agent caps, unlimited usage plus headroom, other container usage and
  in-flight reservations. Unknown/insufficient facts refuse before mutation. Process-local claims
  prevent concurrent requests spending the same capacity and are released on all exits. This is a
  measured candidate policy, not a universal memory guarantee or a new global default.

- **Agent edits** are `lib/agent-edit.ts`, with their state in the `agent_edits` table
  (`lib/agent-edit-state.ts`): the display name (`AGENT_NAME`) and/or the port range are
  applied by rebuilding the container on the current build of its OpenClaw version (a newer build if one was downloaded) — **no backup**, the
  volume is never touched. Same 202-and-background shape as a restore; the parameters
  live in the row, so recovery can tell what was being applied. The panel shows a banner
  and the agent card an `EDITING` chip.
- **Agent restores** are `lib/agent-restore.ts`, with additive preflight/phase/recovery fields in
  `agent_restores`. The 202 response claims the job; expensive checks run in the background before
  stopping the agent. The source is copied to a private directory on the backups filesystem and
  inspected there; extraction uses only those pinned bytes. `lib/backup-inspection.ts` validates
  the gzip/tar stream, canonical config and core SQLite/WAL evidence. Native SQLite integrity work
  runs in a deadline-limited subprocess (`lib/backup-sqlite-worker.js`). Its native dependency
  is resolved through Node from the package working directory set by `rev4a serve`, so a
  bundled module identifier cannot leak into the subprocess. The pure
  `lib/backup-compatibility.ts` shares verified schema ceilings with the cron source reader.
  A cold recovery backup must succeed before replacing the volume; referenced recovery files are
  protected from automatic pruning while their restore history remains. Completion requires actual
  Gateway `/startupz` readiness. Partial failures retain recovery information and stop the agent.
  Startup records active restores as interrupted, except interrupted extraction becomes unresolved
  with its persisted helper name and keeps the volume reserved. It makes no Docker discovery or
  cleanup calls and never revisits historical rows. The operator can confirm Resolve restore in
  Agents > Backups: only that restore's labelled helpers are removed and confirmed absent before
  releasing the reservation. Cold-backup helpers and the agent container are left untouched. Old `done` rows without readiness evidence are labelled as unverified in
  the panel, without inventing a historical failure. Legacy-volume backups wait for migration into
  the host directory; metadata-free archives can use recognized core schemas. A versioned archive
  is checked against the target's core schema ceilings. Unknown targets, unrecognized metadata-free
  schemas, corruption and newer formats refuse before mutation. Core checks do not certify private
  plugin downgrade compatibility.
- **The four job tables share one implementation**: `lib/agent-job-state.ts` builds the
  insert/update/latest/active/`markInterrupted` machinery for `agent_upgrades`,
  `agent_recreates`, `agent_restores` and `agent_edits`; each `lib/agent-*-state.ts` keeps
  only its table's types and function names. They were four near-identical copies that had
  started to drift. At startup `lib/agent-jobs-maintenance.ts` prunes each table to the
  newest 20 rows per agent — the panel reads the latest row only, so the rest is history.

Lifecycle insertion rechecks the latest job of every lifecycle kind and inserts its claim in one
short immediate SQLite transaction (`lib/agent-job-state.ts`). This closes cross-operation races after
asynchronous preflight. Rollback reactivation claims the exact ended, still-latest update row in the
same kind of transaction after its backup/container checks; a changed status, newer update or active
Restore/Edit/Recreate refuses with 409 before scheduling the rollback worker.
Unresolved restore rows keep their existing cross-lifecycle reservation during manual resolution.
A synchronous per-agent action guard prevents duplicate resolves; a failed Docker request keeps
the unresolved row for an explicit retry. There is no startup or periodic restore cleanup scan.
`agentBusyReason` also refreshes synchronous state after its cold-backup
probe. A conflict is an explicit refusal before either job can mutate the agent.

- **Startup repair of the token file mode.** `instrumentation.ts` runs `repairAllTokenFileModes`
  (`lib/agent-token.ts`, not awaited, logged) on every running agent: a `/root/.agent-token`
  that an older release left 0644 becomes 0600 (a constant script that only removes group/other
  permissions, so a stricter mode stays; a missing file or a symlink is left alone; idempotent). Stopped agents are fixed at a later Rev4a start.
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
- **Telegram DM pairing** lives in `lib/channelManager.ts` and the operation-specific
  `lib/channel-pairing-store.js`. Config contains the bot binding; approved senders use OpenClaw's
  native store. Reads prefer the public async `openclaw/plugin-sdk/channel-pairing` export resolved
  from the installed global package, with a legacy sync fallback for older builds. Removal remains
  an isolated private native capability; a read does not require removal support. Clear preflights
  both operations, validates all entries and confirms the final empty list before a bot change or
  disconnect can write config. Pending malformed/unreadable JSON produces an explicit error while
  retaining readable approved results. No new pairing schema or fleet probe is introduced.


**Running commands inside containers** (`lib/docker-exec.ts`):

This module is how a route reaches an agent container. The migration to it is
not finished — routes predating it still shell out directly — so treat these as
the rules for anything you touch, not as a description of the whole tree:

- **Stdin commands have bounded output.** `dockerExecWithInput` counts the combined
  stdout and stderr bytes against `maxBuffer` (default 1 MiB). Exactly the limit
  is accepted; the next byte stops retention, clears the deadline timer, kills
  the Docker CLI child, and rejects once with
  `docker exec output exceeded <n> bytes`. Late output/close/error events cannot
  change the outcome or trigger the missing-wrapper fallback.
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
  `lib/credentials/delivery.ts`, `app/api/workspace/route.ts` (every read, listing and
  save, including the write script fed on stdin).
- **Never interpolate a secret into a command string.** Pass it through the `env`
  option and reference it as `"$KEY"`; command substitution inside an
  interpolated value would otherwise execute on the host. Only the *name* reaches
  argv, as `docker exec -e KEY` — docker forwards the value from its own
  environment, so it appears neither in the host process table nor in any
  rejection built from that argv.
- **Deadlines are enforced inside the container.** Node's `timeout` kills only the
  `docker` CLI client; the process in the container has no TTY and keeps running,
  which piled up dozens of `openclaw devices list` (~200 MB each) on slow agents.
  So `dockerExec`, `dockerExecShell`, their `…NoFail` variants and
  `dockerExecWithInput` run every command as `timeout -k 5 <N> <argv…>`
  (N = the timeout in seconds, rounded up; `-k` rather than `--kill-after=`
  because busybox accepts only the short form; built as an argv array, never a
  shell string), and the host-side timer is only a safety net a few seconds longer.
  `timeout`'s exit 124 reads as "timed out"; exit 137 as "timed out or was killed
  (exit 137)", because an out-of-memory kill of the command looks the same. The
  `…NoFail` variants return '' on a deadline, except for a caller that sets
  `partialOnTimeout` (the credentials probe, whose sentinel proves completeness).
  An image where the wrapper is unusable — no `timeout` (exit 125/126/127 and
  "executable file not found"; Docker Desktop 29 prints that on **stdout**, so
  stdout and stderr are both checked) or a busybox that rejects `-k` (exit 1,
  `timeout: unrecognized option`) — fails once, is retried without the wrapper and
  remembered per container in memory (`unwrappedContainers()`). The wrapped command's own
  output is never proof of that: it can hold any text (a file named `Usage: timeout`), so a
  suspected miss is confirmed by one probe in the same container, run without the wrapper
  (`timeout -k 1 5 true`); only if the probe fails the same way is the container
  remembered, otherwise the original error is thrown. The synchronous cron
  paths in `lib/openclaw-cron.ts` and the daemon's two container reads
  (`containerExec` in `daemon.js`: the costs gateway calls and the packages status)
  use the same wrapper; the argv builder, exit-code mapping and fallback decision are
  one CommonJS module, `lib/exec-timeout.js` (with its `.d.ts`).
  **Not yet covered** (card BUG-7): `app/api/skills/`
  (save, delete, promote), `app/api/gateway/sync.ts` (including the `config patch`
  over stdin) and the gateway agent route, `app/api/agents/` (`config-json`, `token`,
  `create`), `lib/channelManager.ts`,
  `lib/subscription-login.ts` (bounded by its own
  `timeout 900`) and `terminal-ws-server.js`.
- **A host-side kill does not reject.** `docker exec` exits 0 on the SIGTERM Node sends
  when the deadline passes, so a command killed halfway *resolves* with whatever
  it had already printed (this is what remains for a `docker` client killed by the safety-net timer). A `try/catch` therefore cannot tell a truncated read
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

- **Environment file permissions.** Config saves, initial password setup, `writeEnvVar()` and launcher
  writes use creation mode `0600` and explicitly chmod `.env` after writing,
  because creation mode alone does not repair an existing `0644` file.
  `ensureEnv()` also tightens an existing file with broader permissions before
  any content repair or child startup, logging the permission repair once.
  It does not rewrite content just to repair permissions.

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
  report the outcome: the banner records what it asked for, waits for the running
  version to change and only then reloads (see `VersionBanner`).
- **Update state and screen.** `lib/update-state.js` (CommonJS, shared by the CLI and the
  server) keeps `update-state.json` next to `update.log` in the data directory:
  `{ phase, from, to, startedAt, updatedAt, pid, claim?, error? }`, written atomically.
  Phases: `starting` → `installing` → `building` → `restarting` → `done`, or `failed` at
  any point. It is a hint for the UI, never a lock on the install itself. Read rules: older
  than 30 minutes, or more than 5 minutes in the future, is no update; a dead updater pid in
  a running phase reads as `failed` (`restarting` is exempt: the updater exits on purpose);
  `restarting` becomes `done` when a server that started after the write answers *and runs
  the target version* — another version is `failed` ("Rev4a restarted on X, not Y"), and a
  restart nobody picked up within 5 minutes is `failed` too, so the guard lets go.
  The running version is what `server.js` read from `package.json` once at process start
  (`REV4A_RUNNING_VERSION`, `REV4A_STARTED_AT`); the file on disk is not used, because npm
  replaces it before the build and the restart while the old server still answers.
  **Guard:** one update at a time. `POST /api/update-check` and `rev4a update` both go
  through `claimUpdate`, which checks and writes `starting` synchronously with a unique
  claim token before anything is spawned; the route hands its claim to the child in
  `REV4A_UPDATE_CLAIM` and the child's pid replaces the route's only while the state still
  carries that claim. `proxy.ts` answers 503 to mutating API calls while an update is in
  progress (exempt: auth, update-check, update-status, the agents' provider proxy).
  `GET /api/update-status` reports the state, the running version and a redacted log tail;
  `UpdatingScreen` (every tab) and `VersionBanner` judge "the new version answers" from that
  running version through one shared function.

### Browser sessions and password changes (SEC-21)

Login signs the admin JWT with a `pwf` claim from `lib/session-fingerprint.js`
(CommonJS with a sibling `.d.ts`, shared with `server.js`). It is HMAC-SHA256,
keyed by the JWT secret, over `rev4a:session-password:v1\0` followed by the password,
base64url encoded and truncated to 22 characters. The JWT never contains the password.
The helper compares fingerprint strings through fixed-size SHA-256 digests using
`timingSafeEqual`; missing and non-string claims fail closed.

After `jwtVerify`, API authentication (`requireAuthJWT`), the cookie-only session check
(`/api/auth/check`), protected pages (`proxy.ts`) and terminal upgrades (`authorised`
in `server.js`) require the claim for the current effective password. The APIs and
pages use `getPassword()`; the CommonJS server uses
the same environment-first, `.env`-fallback rule, with the same trimming of file
values and data directory. An empty password cannot authenticate a cookie session.
A Config password change applies after restart; until then the inherited environment
still holds the effective password. `Authorization: Bearer <REV4A_TOKEN>` remains an
independent API path. Cookie flags, HS256 and the 7-day lifetime are unchanged.

**Upgrade:** every browser logs in once after updating; older cookies lack `pwf`.
This stateless check automatically refuses the previously issued cookies without a
session table or repair job. No database, `.env`, provider key file or agent volume
is written or migrated. First startup adds no scans or background work, and older
OpenClaw agents are unaffected. Rollback can read all existing data and accepts
the additional JWT claim, but restores the older release's session validation and
loses password-change revocation. `scripts/test-session-fingerprint.mjs` tests real
login tokens against all four verification sites with isolated environment/files
and a VM extract of terminal authentication, without starting `server.js` or using Docker.

### Browser API write boundary (SEC-18)

`proxy.ts` applies the existing update guard first, then a shared origin guard to
POST/PUT/PATCH/DELETE under `/api` (including `/api` itself). The origin guard applies
only when `rev4a_token` is present and `Authorization` is absent; it does not verify the
cookie or Bearer token, which remains each route's responsibility. A request whose browser
sends `Sec-Fetch-Site: same-origin` (and an Origin other than `null`) passes first: the browser
computes it from the real page and target URLs, so it stays right behind a reverse proxy that
rewrites `Host` (nginx's default), and another site cannot forge it. Otherwise, with `Origin`, a
case-insensitive host:port match against `Host` is required. Both authorities are parsed
using the Origin's scheme: explicit and implicit HTTP :80 / HTTPS :443 are equivalent,
while other ports remain significant. For browsers that send no
fetch metadata behind a reverse proxy that rewrites `Host`, an operator can explicitly trust the dashboard's public origin through `REV4A_ALLOWED_ORIGINS`,
a comma-separated list of full HTTP(S) origins; its comparisons include scheme and port,
never wildcards. `X-Forwarded-Host` is not trusted by this check. Literal `Origin: null`
is always refused; malformed or mismatched origins are accepted only by the earlier
`Sec-Fetch-Site: same-origin` branch. Without `Origin`, `Sec-Fetch-Site: cross-site` or
`same-site` is refused; `same-origin`, `none` or absent metadata passes. Refusals are 403 JSON:
`{ "error": "Cross-site request refused" }`.

GET/HEAD/OPTIONS, requests without the cookie and requests carrying Authorization are
untouched by this guard, including the agents' Bearer-authenticated provider calls.
The update guard retains its 503 precedence and existing exemptions; those exemptions do
not bypass the origin guard. The terminal WebSocket retains its independent Origin check
in `server.js`. No database, configuration or agent-volume migration is introduced.
`scripts/test-csrf-origin.mjs` exercises the middleware with real `NextRequest` objects
and an isolated update-state directory, without a server, Docker or real credentials.

The unused gateway provider OAuth route was removed: its GET polled a caller-selected
device flow and saved credentials, allowing login CSRF through navigation. Its device
flow configuration and interfaces were local to the deleted file. `readProviderKeys` and
`writeProviderKeys` remain shared by the live provider configuration, catalogue and proxy.
The Subscriptions page's per-agent ChatGPT login remains a separate, active workflow.

**GET audit (2026-11-08):** the 74 remaining GET handlers in `app/api` were inspected
for direct and helper-driven writes. These existing side effects remain outside this
change's owned code files. Moving them requires coordinating readers, background job
completion, token issuance or bootstrap behaviour; no blanket GET blocking was added.
The locations below identify calls that can cause a side effect, conditional on the
existing job, configuration or legacy data. This is a static audit, without running
Docker actions or sending alerts.

| GET call site | Side effect and implementation |
|---|---|
| `app/api/system-health/route.ts:128` | With alerts enabled, `maybeSendAlert` writes `alert_state` even without Telegram credentials and can send stale-heartbeat or recovery messages (`lib/alerts.ts:44`). Report only: moving alert evaluation off this health read needs a coordinated change to monitoring. |
| `app/api/alerts/smoke/route.ts:16` | When alerts are enabled and smoke is allowed (development, or `REV4A_ALERT_SMOKE=true`), writes `alert_state` even in dry-run mode and can send Telegram messages (`lib/alerts.ts:44`). A method change needs a separate API compatibility change. |
| `app/api/agents/[id]/open-control-ui/route.ts:84` | Issues a single-use bootstrap token via `openclaw dashboard --json` (`lib/agent-devices.ts:251`). The navigation/redirect flow needs a coordinated replacement. |
| `app/api/agents/[id]/cold-backup/route.ts:45`, `app/api/agents/[id]/recreate/route.ts:44`, `app/api/agents/[id]/update/route.ts:32`, `app/api/agents/activity-summary/route.ts:61` | `coldBackupStatus` can finish an exited backup: delete a partial archive, start the agent and remove the backup helper (`lib/cold-backup.ts:188`, `lib/cold-backup.ts:211`). Activity summary can hit this if a listed running helper exits before its status read. |
| `app/api/agents/[id]/update/route.ts:32` | Failed/interrupted update reads schedule a bounded background recheck (`lib/agent-update.ts:758`), which can reapply runtime/provider configuration and mark a DB row resolved (`lib/agent-update.ts:584`, `lib/agent-update.ts:599`), or record a cron-retirement audit (`lib/agent-update.ts:626`). |
| `app/api/subscriptions/openai/login/route.ts:50`, `app/api/credentials/assignments/route.ts:41` | Login status and the assignment busy check can expire an overdue login and terminate its host/container CLI processes (`lib/subscription-login.ts:82`, `lib/subscription-login.ts:287`, `lib/subscription-login.ts:299`). They do not initiate login or save caller-supplied credentials. |
| `app/api/update-status/route.ts:85` | `readUpdate` can rewrite `update-state.json` to `done`/`failed` based on process/version/deadline evidence (`lib/update-state.js:213`). |
| `app/api/agents/[id]/backup/route.ts:43`, `app/api/agents/[id]/update/route.ts:32` | Legacy backup listing/existence checks create temporary `docker run --rm` helpers with a read-only volume mount (`lib/backups-volume.ts:83`, `lib/backups-volume.ts:117`). They do not delete backup data. |
| `app/api/gateway/provider/route.ts:144`, `app/api/gateway/provider/balance/route.ts:32`, `app/api/models/route.ts:40`, `app/api/agents/models-summary/route.ts:102`, `app/api/agents/[id]/model/route.ts:111`, `app/api/provider/v1/models/route.ts:32`, `app/api/costs/agent/route.ts:36`, `app/api/costs/usage/route.ts:39` | Shared key reads can create the parent directory, tighten file permissions and migrate configured environment keys into a missing/unreadable `provider-keys.json` (`app/api/gateway/provider/keys.ts:26`). |
| `app/api/events/route.ts:12`, `app/api/session/route.ts:17`, `app/api/sessions/route.ts:21`, `app/api/sessions/[id]/route.ts:20`, `app/api/system-health/route.ts:66`, `app/api/metrics/alerts/route.ts:41`; lifecycle status reads listed above plus `app/api/agents/[id]/route.ts:155` and `app/api/agents/[id]/restore/route.ts:50` | Even read-only `openDb` calls first run shared bootstrap (`lib/db.ts:9`, `lib/db-bootstrap.mjs:65`): create/migrate schema and metadata, and remove legacy lineage tables when present. These are existing bootstrap effects, not caller-directed mutations. |
| `app/api/credentials/route.ts:14`, `app/api/credentials/[id]/route.ts:23`, `app/api/credentials/[id]/assignments/route.ts:58`, `app/api/credentials/assignments/route.ts:21`, `app/api/credentials/detect/route.ts:167` | First vault read can create/migrate credential schema and tighten file permissions (`lib/credentials/db.ts:15`, `lib/credentials/db.ts:104`). |

Routine in-memory response caches were not treated as persistent state changes.
Rechecking alert/notification senders found only the two GET callers of `maybeSendAlert`
listed above. It delegates to `sendTelegramMessage`; that sender's other production
caller is the daemon (`daemon.js:1525`), outside the HTTP GET handlers. Metrics alert
reads list existing alarms and snoozes; they do not send notifications.
`GET /api/update-check?check=1` also runs `npm view` (`app/api/update-check/route.ts:72`),
which can populate npm's disk cache; it does not start the update (that remains POST).

### 3.2 Agent Container Template (`openclaw-agent-base`)

Docker image for every agent container.

**Contents:** See the live Dockerfile at
`agent-templates/base-image/Dockerfile` (authoritative source).
The image installs `openclaw`, `vercel`, `gh`, `jq`, `supabase`,
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
- The proxy meters every call per agent. Each agent sends its AGENT_ID in an
  `x-rev4a-agent` header (written into its `models.providers.rev4a.headers` by the sync); a call
  without a valid one is metered as `unknown`. Each finished call (status, the provider's own
  token counts, the price in force at that moment) is added to `proxy_usage_hourly` in `costs.db`,
  one row per hour, agent, provider and model. Metering is best effort and off the response path,
  and bounded: a locked `costs.db` costs at most about 200 ms, then metering is skipped for 60 s.
  Agent ids the daemon does not know yet are accepted up to 200 distinct ones per process per hour.

See [GATEWAY.md](dev/GATEWAY.md) and [PROVIDERS.md](dev/PROVIDERS.md) for
detailed documentation.

---

## 4. Credential Management (Vault)

Two separate stores:

- **Provider API keys** — `<data dir>/data/provider-keys.json`, used by the Rev4a
  provider proxy.
- **Third-party service credentials** — `<data dir>/data/credentials.db` (SQLite),
  managed from the Credentials page. Six providers: `github-pat`, `trello`,
  `vercel`, `supabase`, `notion`, `mongodb` (`lib/credentials/providers.ts`).

**Secrets are stored unencrypted.** `credential_secrets.payload` holds raw JSON.
Anything able to read that file, or to reach `POST /api/credentials/[id]/reveal`
with a valid session, obtains them in the clear. Encryption (AES-256-GCM, or an
external vault) is not implemented.

**Delivery is explicit and per agent.** Creating an agent installs nothing. The table
`credential_assignments(profile_id, agent_id, enabled, mode, synced_at, last_error, pending_removal)`
records which credential is switched on for which agent (`agent_id` is the container
name); `mode` is `env` (implemented) or `protected` (reserved).

Enabling an assignment (`lib/credentials/delivery.ts`, pure parts in
`lib/credentials/native.ts`) runs, through `docker exec` with argv arrays:

1. `openclaw --version` must be 2026.9.0 or newer (Trello and MongoDB require 2026.9.9: Trello's image ships the `jq` its skill needs, MongoDB is the only release it was verified on);
2. `openclaw secrets store set NAME --kind env --value-file -` per environment name, the
   value on stdin (never in argv);
3. one `openclaw config patch --stdin` for `skills.entries.<skill>` (`apiKey` SecretRef
   when the skill declares a primary env, `env` map for Trello, plain `enabled` for GitHub);
4. `openclaw secrets reload` with `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:3000` in the exec environment (the agent Gateway port; never `--url`/`--token` in argv). Every Gateway CLI call (the reload, the GitHub RPCs, cron list/edit, the subscription usage read, the devices and update paths) goes through `lib/gateway-cli.ts`, which exports the token from `/root/.agent-token` when that file exists (a token rotated from the dashboard), else keeps the container's `OPENCLAW_GATEWAY_TOKEN`, the entrypoint's precedence; the token is read inside the container.

MongoDB (`lib/credentials/mongodb.ts`) adds steps around the same store write: before step 2 it checks for `mongosh` 2.13.0 under `/root/.local` in the agent and installs it when missing or another version (5 minutes allowed; a failure stops the switch-on before anything is written); it then deploys the shared skill `rev4a-mongodb` to the host's shared skills directory (`ensureRev4aSkill()`), writes the store entry `REV4A_MONGODB_URI` and the skill entry, reloads, and asks `openclaw skills info rev4a-mongodb --json` whether the skill is eligible (60 s). When it is not eligible, or the answer cannot be read, the switch-on fails and the store and skill entries are removed again. A check that times out also fails the switch-on but rolls nothing back, since the state is unknown; the next switch-on retries. A switch-off removes the entries and keeps `mongosh`.

Two providers skip the environment entry, because it cannot work
(`lib/credentials/managed.ts`):

- **GitHub** (`github-pat`): `GH_TOKEN` and `GITHUB_TOKEN` are in OpenClaw's
  `host-env-security` override-blocked list, so a store `env` entry with either name is
  dropped before any command runs and `gh` stays logged out. The delivery writes a one-use
  `github-setup-<32hex>` handoff to the secret store and calls `tools.github.configure`
  (`mode: managed`) over the Gateway RPC; OpenClaw validates the PAT, writes a private `gh`
  profile under its own credentials directory and keeps only `tools.github.profileId` in
  config (which sets `GH_CONFIG_DIR` on each Gateway exec). Disabling calls the same RPC
  with `mode: inherit`. The bundled `github` skill is still switched on.
- **Vercel**: the CLI resolves its scope from the account default team and, for a
  `northstar` account, forces it even when `config.json` names another team, so a
  `VERCEL_TOKEN`-only environment inherits a default team the token may not reach and every
  command fails. The delivery discovers an accessible team from the Vercel API and writes
  the CLI's own `auth.json` + `config.json {currentTeam}`.

Disabling on OpenClaw 2026.9.0 or newer runs `openclaw secrets store rm --yes NAME`, the same patch with `null`, and reload. Older agents have no secret store or managed GitHub identity; disabling skips those steps and cleans only legacy files (including Vercel CLI files).
Every step is attempted even when one fails; any failure keeps the row in `pending_removal`
with `last_error` (retried at re-apply, blocks deleting the credential), never thrown out of a
batch. The removal runs only for a row that is enabled or pending: a sibling replaced by
another profile of the same provider shares the environment names and is left alone. Error
texts are stripped of the secret values (raw, trimmed and JSON-escaped forms).
Calls on one container are serialized on the agent's config lock (below): the patch rewrites openclaw.json. After a
successful native delivery the files and TOOLS.md row an earlier release wrote for that
provider on that agent are removed. `applyRuntimeConfig` starts, in the background and
without delaying the caller, a re-apply of the agent's assignments (enabled ones delivered
again, pending removals retried) after create, recreate, update and edit; the restart and lifecycle routes do the same after a restart or start, and restore and rollback do so after a successful start once the Gateway is ready. Credential changes on
a stopped or busy agent are refused (409) when they write into the container; an intent-only removal changes Rev4a's table without a container write. The store and `openclaw.json` live on
the agent volume. Environment entries reach Gateway-hosted exec but not the Codex native
shell. Deleting an agent deletes its assignments. A successful switch updates the profile's
`last_synced_at`/status and writes `sync`/`desync` audit entries. Failed delivery changes status but leaves `last_synced_at` at the last successful delivery.

**Rollback.** The previous Rev4a still reads the vault and does its old delivery, but it knows
nothing of the secret store and of the managed GitHub identity: its switch-off removes neither.
Before rolling Rev4a back below this version, switch credentials off here (the store entries and
the `gh` profile live on the agent volume, so they survive a recreate otherwise). Protected mode
(`kind: secret` plus an egress proxy) is a separate decision.

**One write queue per agent for `openclaw.json`.** Several things write that file:
`openclaw config patch` (runtime config in `lib/agent-setup.ts`, the Rev4a provider block in
`app/api/gateway/sync.ts`, the model changes in `lib/subscriptions.ts`, credentials in
`lib/credentials/delivery.ts`) and whole-file rewrites (agent create, `PUT /api/gateway/agent`,
the Telegram channel in `lib/channelManager.ts`, and `syncAllAgents`). All of them run through
`withAgentConfigLock(container, fn)` in `lib/agent-config-lock.ts`: one promise chain per
container on `globalThis` (every route bundle shares it), a failure never blocks the next
writer, a holder past 2 minutes is logged. A rewrite reads and writes inside the same hold.
The lock is not re-entrant: code inside it must not take it again for the same container.
Different agents never wait for each other. Test: `npm run test:agent-config-lock`.

`GET /api/credentials/detect` reports which credentials each container really holds, and the
Credentials page drives its switches from it: the container is the source of truth, `credential_assignments`
is only Rev4a's intent (re-applied after create, recreate, update, edit, restore, rollback, start and restart). The one probe
exec per container (`PROBE_SCRIPT`, fixed text) reads every delivery method with one constant `node -e` script
(`DIGEST_SCRIPT`) that runs inside the agent and prints hashes only: the OpenClaw secret store (table
`secret_store_entries` of `~/.openclaw/state/openclaw.sqlite`, read-only; not the CLI, which masks some values),
the managed GitHub identity (`agents.entries.main.tools.github.profileId` of the parsed `openclaw.json`, then that profile's `hosts.yml` under
`~/.openclaw/credentials/github/agents/*/<profileId>/`), the Vercel `auth.json`, and the files earlier releases
wrote. The hash is `hashToken` (SHA-256 of the trimmed value, 12 hex characters), so no raw token ever leaves
the container nor reaches Rev4a's logs; the parser (`lib/credentials/detect.ts`) matches hashes to the stored
profiles. The script ends each read with a marker (`store-ok` after the secret store, including an older database without the table; `digest-ok` as the last line): without them the answer for those providers is `present: null` (unknown), never "holds nothing". After a start, restart, create, recreate, update, edit, restore or rollback, `reapplyWhenReady` polls `/startupz` for up to
10 minutes and then re-applies; a Gateway that never gets ready is recorded as `last_error` on each enabled
assignment (only `last_error`: a row already delivered keeps `synced_at`; nothing is recorded if the container stopped while waiting).

**Planned:** encryption at rest, and the protected delivery mode.

---

### Subscriptions (ChatGPT / Codex)

A ChatGPT Plus or Pro account is connected **per agent**, with OpenClaw's device-code login (`openclaw models auth login --provider openai --device-code`). The resulting OAuth profile lives in the **agent's volume** (`~/.openclaw/state/openclaw.sqlite`), so it survives restart and recreate; **Rev4a never stores or sees a token** (there is no table and no file for it). The access token lasts about 10 days and OpenClaw refreshes it itself.

The login runs as an in-memory job (`lib/subscription-login.ts`, one per agent): after the agent's Gateway reports ready, `docker exec` runs the command under `script -e -qfc` (it needs a TTY; `-e` returns the child's exit code, because util-linux `script` 2.38 exits 0 whatever the child did) bounded by `timeout 900` (a job counts as expired 900 + 60 s readiness + 60 s tail = 1020 s after it started, even if its `docker exec` hangs), and the output (ANSI, spinner redraws, possibly one character per line) is parsed by `lib/subscriptions-parse.js` into a link, a code and an outcome. The device code is 4 characters, a dash and 5 characters (`LBVC-84CXA`); the parser accepts it only after the link and only once another character follows it, so a code still arriving is never frozen half-read. Starting registers a placeholder job before the first await and takes the per-agent lock shared with disconnect, so two POSTs cannot start two logins; a POST on an agent whose login is running returns that job. Before spawning, a kill script clears a stale login process left by a lost job (it matches only `models auth login --provider openai --device-code`). The outcome is settled in this order: OpenClaw's own failure message, `timeout`'s 124 (expired), then exit 0 plus a confirmed OAuth profile (connected). The job does not wait for the exit when it can avoid it: as soon as the output says OpenAI completed, it confirms the profile with the fast status read and reports connected (the CLI then spends several more seconds rewriting the config and checking the default model). Until that process exits the agent stays busy for recreate, update and edit, and a disconnect started meanwhile waits for the exit (bounded) before it writes the config. A dashboard restart loses the job; the in-container `timeout` bounds the orphaned process. While a job runs the agent counts as busy (`lib/agent-busy.ts`). Status comes from one `docker exec node -e` inside the agent (`STATUS_SCRIPT` in `lib/subscriptions.ts`, about 0.5 s): it opens `openclaw.sqlite` read-only (`config_machine_state`, row `authProfiles.store`) and `openclaw.json` and prints one JSON line with the profile id, email, plan (`chatgptPlanType`), expiry and the model. `access`, `refresh` and `accountId` are never copied, and `parseStatusJson` drops any other key, so **the tokens never leave the container**. An agent whose state is not where 2026.9.x keeps it (no `node:sqlite`, no state database, no profile table) is answered `{"unsupported":true}` by the script and refused with one message ("This agent is not on a supported OpenClaw version (2026.9.x). Update it first.", 409), unless the image's version cannot be told (a Docker call that times out, or an image without a version): that is "the agent is still starting", a retryable failed read, never an unsupported refusal. The image's version is compared by major.minor (any 2026.9.x build is the supported 2026.9 line); a read that fails throws "Could not read this agent's subscription status: <reason>" (503), where `<reason>` is a fixed phrase (the script prints one category to stderr, never the exception text). A failed read is retried up to twice (1 s, 2 s; a timeout once at most; worst case about 27 s), and the login's final confirmation says "The login may have succeeded but the agent could not be read" rather than "holds no account" when the read still fails. There is no CLI fallback. Per-agent status is not cached: each row of the page reads its own agent (the container list behind it is cached 5 s, so N parallel rows share one `docker ps`). Connect refuses an agent whose read is unsupported (409) or fails (503). Disconnect runs each `models auth logout` under an in-container `timeout 60`, reverts the `main` entry of `agents.list` like the defaults, and reads the profiles back (a timed-out `docker exec` resolves with no output and leaves the process running), then stops the Codex runtime: OpenClaw runs the ChatGPT models through the Codex app-server (installed on first use under `~/.openclaw/npm/projects/openclaw-codex-*`, about 336 MB per agent; one app-server per session that used the subscription) and the gateway keeps it running after a sign-out, so `STOP_CODEX_SCRIPT` (fixed text in `lib/subscriptions-parse.js`) ends those processes. Verified on 2026.9.3: the gateway stays healthy and the next subscription turn starts a new app-server by itself, so no gateway restart is needed. The model list is the one remaining CLI read (`models list`, cached 10 min per account). Disconnect is an in-memory background job (`lib/subscription-actions.ts`, 202 and polling, one per agent, under the same lock; a running job makes the agent busy). There is no model job: the agent's model is chosen in the MODEL section of the agent panel and saved through `PUT /api/gateway/agent` (the model panel's writer of `agents.defaults.model`; disconnect and the login CLI itself also write it).

**Usage limits.** The Codex quota (a 5-hour and a weekly window) belongs to the ChatGPT account, not to an agent: every agent signed in with it and the owner's own Codex use draw from the same windows. So `lib/subscription-usage.ts` reads it once per account email, from one running connected agent (found with the fast status read, cached 60 s), with `openclaw status --usage --json` run as `timeout 120 sh -c 'OPENCLAW_GATEWAY_URL=ws://127.0.0.1:3000 openclaw status --usage --json'` (11 to 50 s on a slow host, about 360 MB; the host-side deadline is 130 s, and empty output is a failure). `lib/subscriptions-parse.js` (`parseUsageStatus`) keeps only the `openai` provider's email, plan, window label, percent and reset time. The result, and a failed read too, is cached per account for 3 minutes (a result read before a connect or disconnect is not stored, but the cache is not dropped by them: the quota belongs to the account; only `refresh=1` forces a read), concurrent requests share one call, and one account failing never fails the others.

A subscription model is used as `agents.defaults.model.primary = openai/<id>` (or as a fallback), chosen in the agent panel next to the Rev4a proxy models; when it is chosen as primary on an agent with no fallbacks, the panel pre-fills the former primary as `fallbacks[0]` (the operator can remove it). So when the account's Codex usage limit is reached ("You've reached your Codex subscription usage limit"), OpenClaw falls back by itself to the `rev4a/<model>` through the Rev4a proxy. The quota is the account's, **shared with the owner's own Codex use**. Nothing in this feature writes `models.providers.*`.

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
- Rev4a's own shared skills live in the package under `rev4a-skills/<name>/SKILL.md` (names start with `rev4a-`; today `rev4a-mongodb`). `rev4a serve` copies each one into this directory at start when its text differs (`ensureRev4aSkills()` in `bin/rev4a.js`), and a MongoDB switch-on does the same through `ensureRev4aSkill()` in `lib/rev4a-skills.ts`. Other skills in the directory are never touched; nothing is copied into a container.
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

1. Read every running agent's sessions from its own container (`sessions.list` through the Gateway CLI, plus `cron runs`), every 30 s while something runs and at most once a minute otherwise
2. Keep them in `events.db` table `agent_sessions`, keyed by `(container, session_key)`
3. Emit `session_started` / `subagent_spawned` / `session_ended` / `session_failed` / `session_aborted` events into the `events` table (`session_id` = the session key, `data.container` = the container)
4. Sample the host machine (CPU, RAM, swap, storage) every 30 s into `metrics.db`, on a
   timer of its own
5. Sample what each container consumes every 60 s, and the disk Docker holds every 10 min,
   into `metrics.db` (see [Container Consumption](#container-consumption))
6. Detect anomalies (CPU > 85%, RAM > 90%, a disk at 90%) and record them as events
7. Read what each running agent spent, as its own OpenClaw priced it, every 5 min into
   `costs.db`, and each vendor's balance or usage every hour (see [Agent Costs](#agent-costs));
   prune `proxy_usage_hourly` (the proxy's per-agent meter) of rows older than 400 days
8. Manage DB lifecycle (WAL mode; events.db checkpointed after each pass that changed something)

### Agent sessions (lineage collector)

The host `openclaw` is not read any more: a Mac's own OpenClaw no longer feeds the Lineage
page, only the agents (containers) do. Per running agent, one at a time and never two passes
at once, the daemon calls `sessions.list` (`limit 200`, `archived: all`, paged by
`nextOffset`) through the agent's Gateway CLI, with the token read inside the container.
Only the `main` OpenClaw agent's sessions are kept. A call costs 5-12 s (a CLI start-up), so an
agent is read every 30 s while one of its sessions runs and every 60 s when idle; an agent that
fails is read less often (doubling up to 10 min) and logged once.
Cron runs are not in `sessions.list`: for each cron job whose row moved, `cron runs` is read
(at most 5 jobs per pass, 5 min apart) and stored as kind `cron_run`.

Transitions are computed against the **stored** row, so a restart writes no event. A new session
writes `session_started` only when it was active in the last 10 minutes (an older one was
found, not seen starting). A failed, timed-out or garbled answer changes nothing; an empty list
is believed only with `totalCount: 0`. A stopped container keeps its rows with `gone_at`;
rows missing from a complete listing get `gone_at` too. `agent_sessions_meta.version` is bumped
by every pass that changed something. Retention: rows idle for 30 days are deleted, cron jobs
and runs after 7 days (hourly, in batches of 5000).

The old `sessions` and `lineage` tables are dropped by the bootstrap (`lib/db-bootstrap.mjs`, LIN-6) and no longer created.
Costs per session stay in `costs.db`; `agent_sessions.cost_usd` is OpenClaw's estimate or NULL.

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
`[METRICS] disabled` in the log — and the session collector keeps running. The API side reads
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
previous one in place. A running cold-backup helper (name `rev4a-backup-…` with the label
`rev4a.backup.agent`, identified in `lib/backup-helper.js`) is named "Backup of <agent> (<kind>)" by the sampler
(the agent's `AGENT_NAME`, else its id; cached per container id) and stays a non-agent row; the read side lists
it only while it runs. `lib/container-metrics.ts` reads it all for `GET /api/metrics/containers`
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

**Subscription calls are not spend.** One rule, `isSubscriptionProvider()` in `lib/agent-costs.ts`: providers `openai` (OpenClaw's native ChatGPT/Codex route) and the legacy `openai-codex`. Rev4a never gives an agent an OpenAI API key, so every `openai` row is taken for a subscription call (assumption: an operator who adds their own OpenAI key by hand would see those calls counted as subscription usage). Every spend reader leaves them out: `agent_cost_daily` has no provider, so the per container/day sums of the subscription rows of `agent_cost_model_daily` are subtracted (never below 0, and a residue under 1e-9 is 0; the split by kind input/output/cache is scaled to what remains, so it is approximate on a day that mixes providers). The most expensive sessions keep a session whose current provider is a subscription, labelled "includes ChatGPT subscription calls at API value": OpenClaw keeps one total per session and records only its current provider, so the session can mix paid proxy calls and plan calls and cannot be split. `readSubscriptionUsage()` reports them apart — tokens, calls and the API value OpenClaw priced them at — for the Costs page (`subscription` field of `GET /api/costs/usage`) and the agent panel. The proxy comparison's recorded side is therefore without them too: subscription calls never go through the proxy. No schema or daemon change. The unpriced counts (`missing`, the "calls without a price" warning) are not reduced: OpenClaw counts them in usage entries and the model rows in calls, so taking the subscription share out could hide an unpriced paid model; an unpriced subscription model shows there too.

After a pass, at most once an hour, the daemon also reads each vendor's own figure —
DeepSeek's balance, OpenRouter's lifetime usage (read-only calls, never billed) — and stores
it next to the agents' cumulative priced total for that vendor's models, in the same row
(`vendor_balance`). Between two rows, what the vendor billed and what the agents priced
cover the same interval: the Costs page's *Against the bill* (`lib/cost-reconciliation.ts`).
`costs.db` is opened in a try: if it cannot be, collection is off (`[COSTS] disabled`).

`costs.db` has a second writer: the dashboard's provider proxy, which adds each call it carries to
`proxy_usage_hourly` (see [AI Provider Gateway](#33-ai-provider-gateway-implemented)) and may create
that table before the daemon has run; the readers keep their read-only handle. `GET /api/costs/usage`
answers a `proxy` block with each agent's recorded figure next to the proxy's (`unknown` callers listed
but not added to Spent); the Costs page's Spent is the larger of the two per agent.

### Anomaly Detection

After each sample the daemon inserts a `system_anomaly` event into `events.db`
(`{ metric, values, threshold, message }`) and logs `[ANOMALY] <message>` when:

| Metric | Condition | Repeats |
|---|---|---|
| CPU | > 85% on two consecutive samples | at most once per 5 min |
| RAM | > 90% on two consecutive samples | at most once per 5 min |
| Disk (each filesystem) | ≥ 90% | once when it reaches it, no cooldown — again only after it drops back under, or after the daemon restarts |

The container samples (every 60 s, `collectContainerMetrics`) add two rules, evaluated by
`lib/container-anomalies.js` only after a sample was read and stored (a failed Docker read
evaluates nothing). Same event shape; the detector keeps its streaks and cooldown in memory:

| Metric | Condition | Repeats |
|---|---|---|
| `container_pids` | `pids` ≥ 1000 on 2 consecutive samples of the same container | at most once per 60 min per container |
| `container_memory` | `mem_mb` ≥ 90 % of Docker's memory (`memTotalMb`) on 5 consecutive samples | at most once per 60 min per container; no rule without a known total |
| `container_oom` | Docker's `oom` event for a container carrying `AGENT_ID` (a process was killed for lack of memory, with or without a memory limit) | at most once per container per 10 minutes, counting the kills in between; written by the OOM stream in `daemon.js`, not by the detector |

A fourth alert, `packages_failed`, comes from `collectPackagesStatus` in `daemon.js`, not from the detector: 60 s after start and then every 10 min it lists the running agent containers (`AGENT_ID` label) and, one at a time, runs `docker exec <container> cat /root/.rev4a/packages-status.json` (argv, 5 s timeout). The status is read with a 1 MB buffer; a "no such file" answer (an image without the recorder) is not logged, any other read failure is logged once per container. A status of `failed` or `partial` records one anomaly with the `container` field and `values` = the failed package names, once per (container, `at`) in memory; a status whose `at` is older than the daemon's start minus 24 h is skipped, so a daemon restart repeats an old failure at most once a day. Parsing is `lib/agent-packages.js`. An unreadable file (older image, stopped container) is silent apart from one log line. The same file backs `GET /api/agents/[id]/packages` and the panel's SYSTEM PACKAGES section.

A sample with a missing / non-numeric value resets that streak. A container whose stats
read failed but that Docker still lists keeps its streaks; a container that is gone is
forgotten, and a gap of more than 180 s between two samples resets the streaks. After a daemon restart the streaks start over.
The machine rules keep their 5-minute cooldown.

**Out-of-memory kills.** `State.OOMKilled` is true for about a second and is reset when the restarted container starts, so the only durable trace is Docker's `oom` event (also fired when only a child process such as Chrome is killed). The daemon keeps one long-lived `GET /events?filters={type:container,event:oom,label:AGENT_ID}` stream open on the Docker socket (no `until`; newline-delimited JSON, split across chunk boundaries by `createLineSplitter` in `lib/agent-memory-limit.js`). A live stream applies the filters on the Docker side, so it does not depend on Docker's replay buffer: Docker keeps only the last 256 events of every type for `since`/`until` replays, and Rev4a's own `docker exec` polling fills most of it, which is why a periodic replay could lose an `oom` event. When the stream ends or fails, the daemon reconnects with a backoff (1 s, 2 s, 5 s, 10 s, 30 s, then 60 s) and `since=<time of the last event seen, or of the disconnect>` so a short gap is replayed best-effort (duplicates are ignored); the disconnect is logged once per outage, not per retry. The first connection after a start has no `since`: no history is replayed. The stream is closed in both shutdown handlers and never blocks or stops the metrics pass. For each event the container's limit is read at event time (inspect by `Actor.ID`, 5 s timeout). `createOomTracker` limits alerts to one per container per 10 minutes: kills inside the cooldown are counted and the next alert says "N kills in the last M minutes"; a failed write stays pending and is retried on the next event or within a minute. Each alert is a `container_oom` anomaly whose data carries an extra `container` field (and `kills`) and `values: [limit in MB or null]`; the message says "no memory limit set" when the container had none (a host can OOM-kill an unlimited container).

The spend and loop alarms (`lib/spend-alerts.js`, FEAT-15) are `system_anomaly` events too (metrics `spend.*`, with `agent`, `container` and `scope` in the data), written by the daemon right after each costs pass and sent to Telegram through `lib/alerts-send.js` when configured.

No feature consumes `system_anomaly` events yet except Recent alerts on the System page;
otherwise they only pass through the generic event feeds.

### Events Retention

On its own timer (first pass 10 s after start, then every 6 hours) the daemon deletes events
older than 30 days from `events.db` (`lib/events-retention.js`), in batches of at most 5 000
rows, at most 100 000 rows per pass; when a pass hits that limit, the next one runs after
60 s instead of 6 hours. It does not depend on OpenClaw being installed or on `metrics.db` opening, so it runs on
every host. The 7-day cron-session retention in the poll is separate.

### DB Safety

- WAL mode + `PRAGMA synchronous = NORMAL` for concurrent read safety
- `PRAGMA wal_checkpoint(PASSIVE)` runs after each poll cycle, `FULL` every 10 cycles
- On `uncaughtException` the daemon logs but does NOT exit — relies on systemd Restart=always for recovery

### Migrations

Schema steps live in `lib/db-bootstrap.mjs` and are idempotent; since LIN-6 it also drops the old `sessions` and `lineage` tables. See `docs/dev/DATABASE.md`.

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

### Login throttle

`POST /api/auth/login` is rate limited per client address (`lib/login-throttle.js`, one instance per server process,
`app/api/auth/login/route.ts`). 5 failures in a 1-hour window are free; from the 6th the address is locked for 30 s,
doubling with each failure, capped at 15 minutes. The lock level is the most failures the address has had in a window
since it last went a whole hour without one, so an attacker retrying at every unlock stays at the 15-minute cap (about 4
attempts an hour) instead of sliding back as old failures leave the window. A locked address gets `429` with
`Retry-After` and its password is not checked. A success clears the address. The map holds at most 10 000 addresses;
when full it evicts the least recently active address **without a running lock**, and only if all are locked the one whose
lock ends soonest. Expired entries are dropped lazily, with no timers. The counters are in memory only: a restart resets them.

The key is computed in `server.js` (`lib/client-address.js`, `clientAddress()`) for every HTTP request and handed to the
route in the internal header `x-rev4a-client-ip`; `server.js` first deletes any such header sent by the client. It is the
socket peer (`::ffff:1.2.3.4` normalised to `1.2.3.4`); an IPv6 key is reduced to its **/64** (`2001:db8:1:2::/64`) by
`throttleKey()`, which `clientAddress()` applies to its result. The **rightmost** `X-Forwarded-For` entry (the one a
proxy appended) replaces the peer **only** when the peer is listed in `REV4A_TRUSTED_PROXIES`; a malformed entry falls back
to the peer. With the variable unset no peer is trusted, loopback included: agent containers and LAN clients (private
addresses), and on Docker Desktop even containers (they reach `host.docker.internal` from 127.0.0.1), would otherwise
pick a fresh key with every request.

`REV4A_TRUSTED_PROXIES` is a comma-separated list of IPs or CIDRs (IPv4 and IPv6, e.g. `192.0.2.10`), parsed once at
start-up by `parseTrustedProxies()`; invalid entries are ignored with one warning, and a very wide entry (`0.0.0.0/0`,
`::/0`, shorter than /8 or /16) is accepted but logged as a warning. A proxy on the same host is listed as
`127.0.0.1,::1`; that trusts every local process, and on Docker Desktop (macOS/Windows) also the agent containers, so
there prefer a proxy with its own distinct address, or accept the risk. When the proxy runs in Docker, list the proxy's
own address and PIN it (a static `--ip` / `ipv4_address` on a network dedicated to the proxy and Rev4a). Do not put the
proxy on `rev4a-network` with the agents: Docker assigns container addresses dynamically, so after a restart an agent can
take the proxy's old address and be trusted. Listing a whole agent network lets any agent pick its own key.

Failure mode: a proxy that is not listed, or a listed proxy that sends no `X-Forwarded-For`, puts every visitor under one
key (the proxy's address, `127.0.0.1`, or `::/64` for a proxy over `::1`). While an attacker sharing the owner's key
keeps trying, the owner stays locked out; after the attacker stops, one owner typo within the hour still costs up to 15
minutes (the peak rule). To recover at once, restart Rev4a (`sudo systemctl restart rev4a` on a systemd install, or
restart `rev4a serve`). Under `next dev` there is no header and the key is `unknown`. Out of scope: Bearer-token API
calls, the terminal WebSocket, persisted counters.

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

### Manual restore resolution

`agent_restores.helper_name` and `source_directory` are additive nullable audit fields. The helper
is created before starting extraction, with agent/job labels and a unique name. Removal is followed
by an independent Docker inspect (only 404 proves absence). Unknown cleanup keeps status
`unresolved`, `finished_at = NULL` and the lifecycle reservation; the pinned source stays.
Startup only marks active restores for review; an interrupted extraction becomes `unresolved`.
There is no startup or periodic Docker cleanup scan, and historical rows remain unchanged.
Agents > Backups > **Resolve restore** requires explicit confirmation, then removes only helpers
labelled with that agent and restore row ID and independently confirms absence. It excludes the
agent container and cold-backup helpers, works if the agent container is absent, and releases the
reservation if no labelled helper remains. Successful resolution records `interrupted` with phase
`manually_resolved`; Docker failures or unconfirmed removal retain `unresolved` for explicit retry.
Resolution never re-extracts, restarts the agent or proves data integrity. The operator must review
the current volume and recovery backup before continuing.
