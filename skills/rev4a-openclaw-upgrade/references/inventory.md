# Rev4a ↔ OpenClaw dependency inventory

Everything in Rev4a that depends on OpenClaw, with its call sites. An evaluation checks the target
release against every row.

On upgrade, verify that the `models.authLogout` RPC exists and accepts `profileIds`.

## How to keep this file current

- **A Rev4a change that adds, moves or removes a touchpoint updates this file in the same commit**:
  a new `openclaw` command or flag, a config key read or written, a path on the volume or in the
  image, a JSON field parsed, a text pattern matched, a version check, an image build step, or a
  new action that reaches every agent (section G) or runs without a user action (section H).
- One touchpoint per table row. IDs are stable: never renumber or reuse one; a removed touchpoint
  keeps its row, marked **removed** with the commit. A new row takes the next free number of its
  prefix (C25, KR14, P19, B33, …). The lettered lists G and H use the
  prefixes FL and AU under the same rule; lists A-F and I have no IDs.
- Exact tokens (commands, flags, keys, paths, field names) go in backticks, written as Rev4a uses
  them, so scripts can extract them. Call sites are `file:line` or `file:start-end`, separated by
  `;` between files.
- `references/deps.json` mirrors the machine-checkable rows for `rev4a-deps.mjs`: config keys
  (KR, KW), JSON fields (J), commands and flags (C, E4), paths (P), SQLite tables (S) and retired
  paths. A change to one of those rows updates `deps.json` in the same commit. The other rows
  (behaviour, timeouts, fleet actions) are read by a person.
- Line numbers drift: when a reference no longer points at its touchpoint, grep for the token and
  fix the reference. A reference past the end of its file, or with none of the row's tokens near
  it, is a defect of this file.

## Provenance

Built from branch `feat/oc-10-openclaw-2026-10`, HEAD `b064ab9`, read 2026-11-04 (code only; the
2026.9.9 → 2026.10.10 evaluation then checked the rows live). Every `file:line` re-verified on
2026-11-05 against the same HEAD plus the uncommitted `Dockerfile` and `lib/agent-versions.json`
changes; rows KR13, P18, J17, V14-V15, B25-B32 and sections G-I added then.
Supported versions in the evaluation's working tree (`lib/agent-versions.json`; `2026.10.10` staged for the evaluation, not on `main`): `2026.10.10` (no imageRevision), `2026.9.9` (`384bd8e`), `2026.9.3` (`28cf675`); every entry `modelInput: [text, image, audio, video]`. Dockerfile `ARG OPENCLAW_VERSION=2026.10.10`.

Paths are relative to the repository root. "Silent" = Rev4a shows wrong or empty data, or skips an action, without an error a user sees. IDs (C1, R1, …) are stable: rows, `deps.json` and reports refer to them.

---

## Summary

| Category | Rows |
|---|---|
| CLI command (C) | 24 |
| Gateway RPC, `openclaw gateway call` (R) | 5 |
| HTTP endpoint of the gateway / Control UI URL shape (H) | 4 |
| openclaw.json key read (KR) | 13 |
| openclaw.json key written (KW) | 13 |
| File / directory path on volume or image (P) | 18 |
| SQLite table / column read inside the container (S) | 4 |
| OpenClaw internal module / process / package (I) | 4 |
| Env var / CLI flag (E) | 6 |
| Output JSON field parsed (J) | 17 |
| Log line / text pattern matched (T) | 15 |
| Version-dependent logic (V) | 15 |
| Image build step (B-) | 12 |
| Behaviour assumption (B) | 32 |
| **Total** | **182** |

Plus the cross-cutting lists at the end: A. OpenClaw-owned / built-in things compared or counted (12), B. fixed timeouts (56), C. memory limits and memory use (10), D. human-text parsing (12), E. pages that display OpenClaw data, F. docs, G. fleet actions (20, FL1-FL20), H. code that runs without a user action (16, AU1-AU16), I. text about OpenClaw behaviour (5), J. side findings (8).

Changes on 2026-11-05: 169 → 182 rows (13 added, see Provenance); the earlier count of fixed timeouts (52) was wrong, the table had 56 rows.

### The 15 most fragile touchpoints across OpenClaw releases

| # | Touchpoint | Where | Why fragile |
|---|---|---|---|
| 1 | Pairing reads prefer public async SDK I5; legacy sync reader and private native remover remain capability probes in `lib/channel-pairing-store.js` | `lib/channel-pairing-store.js`; `lib/channelManager.ts` | Public reader and private removal have separate support. Clear failures stop config writes; legacy sync deprecation remains relevant only to fallback builds. |
| 2 | `usage.cost` + `sessions.usage` field names (`daily[].totalCost`, `aggregates.modelDaily[].count`, `sessions[].usage.totalCost` …) read through `num()` that maps anything missing to 0 | `daemon.js:982-1052` | `wellFormed()` checks only that the arrays exist; the pass deletes the 30-day window first (`clearDaily`/`clearModelDaily`) and re-inserts. A renamed field silently overwrites a month of costs with zeros. `cacheStatus.status !== 'fresh'` semantics are also assumed. |
| 3 | `/startupz` contract: 503 while starting, 200 + JSON `{"status":"started"}` when ready, `version` in the body | `lib/agent-readiness.ts:57-112`, `lib/agent-devices.ts:101-110`, `lib/agent-update.ts:142-149` | Any change of status code or body makes every wait time out: **create deletes the new container and its volume** (`app/api/agents/create/route.ts:319-330`), recreate/edit/update fail, Agents page shows "not ready". A missing `version` breaks browser-approval detection and update verification. |
| 4 | Transcript counting for update verification: `agents/*/sessions/*.jsonl`, `session-sqlite-import-archive/archive-tier.<id>.jsonl.imported-<ts>`, `agents/*/agent/openclaw-agent.sqlite` table `transcript_events(session_id)` | `lib/agent-update.ts:69-119` | Three storage layouts hard-coded. If a release moves events (another table/file), the after-count drops to 0 → false "lost events" failure that offers a destructive rollback; if the baseline cannot see them, verification passes vacuously (silent). |
| 5 | `STATUS_SCRIPT`: `/root/.openclaw/state/openclaw.sqlite`, `config_machine_state.value_json WHERE state_key='authProfiles.store'`, profile fields `type, provider, email, expires, chatgptPlanType`, id prefix `openai:` + `type==='oauth'` | `lib/subscriptions-parse.js:139-216`, `lib/subscriptions.ts:200,243-265` | Raw internal state DB. A moved row/table reads as `unsupported`, which on a supported image becomes "the agent is still starting" forever; renamed profile fields silently drop email/plan/expiry; a different id prefix hides a connected account. |
| 6 | `DIGEST_SCRIPT`: `secret_store_entries(name,value,kind,deleted_at_ms)`, `agents.entries.main.tools.github.profileId`, `credentials/github/agents/<hash>/<profileId>/hosts.yml` (`oauth_token:`, `user:`) | `lib/credentials/detect.ts:141-162` | A missing/renamed table prints `store-ok` with zero entries → credentials page silently reports nothing installed (drift, re-delivery prompts). Path or YAML change silently hides the GitHub identity. |
| 7 | Device-code login parsed from ANSI terminal text: URL `https://auth.openai.com/codex/device`, code `XXXX-XXXXX`, `expires in N minutes`, `OpenAI device code complete|failed`, `timed out` | `lib/subscriptions-parse.js:9-53`, `lib/subscription-login.ts:57,186` | Pure human text, run under `script` for a TTY. Any wording/format change leaves the operator without a code or never marks the login done (until the 900 s timeout). |
| 8 | Whole-file writes of `/root/.openclaw/openclaw.json` (`cat >`), relying on the Gateway's file watcher + hot reload and on the file being the source of truth | `lib/channelManager.ts:69-79`, `app/api/gateway/agent/route.ts:192-196`, `app/api/agents/create/route.ts:411-415`, `app/api/gateway/sync.ts:234-253,488-494` | Sync All does it to **every agent, running or stopped, at every Rev4a start** (B25, FL1-FL3). No validation (unlike `config patch`). If OpenClaw moves config into its state DB, tightens schema at reload, or stops watching the file, Telegram/model/provider changes report success and silently do nothing (or break the next start). |
| 9 | `rm -f /root/.openclaw/agents/main/agent/models.json /root/.openclaw/agents/main/agent/auth-profiles.json` on every Sync All, so at every Rev4a start on every running agent (FL1) | `app/api/gateway/sync.ts:476-486` | Blind delete of OpenClaw-owned files "from old versions". If a release uses either path again for live state (auth profiles lived there before 9.x), Sync All silently logs agents out / wipes their model registry. |
| 10 | Proxy metering: OpenClaw must send the derived `models.providers.rev4a.apiKey` Bearer token on every call (the identity header remains for legacy readers), and the answer must carry a `usage` block (JSON body or the last SSE chunk) | `app/api/gateway/sync.ts:278-288`, `app/api/provider/v1/chat/completions/route.ts:96-101`, `lib/proxy-usage.js:128-190`, `lib/spend-alerts.js:219-227` | Never exercised by an OpenClaw snapshot. A dropped/changed token refuses the call; the header cannot override a derived-token identity (only legacy shared-key calls depend on it); historical known ids retain attribution after deletion, ids outside that set meter as `unknown`, and root rotation revokes all tokens until sync; a missing usage block counts as `no_usage`, which raises false `spend.loop` alarms for every agent. Silent, every install (B26, J17). |
| 11 | `sessions.list` row mapping: only keys `^agent:main:`, `kindFromKey` vocabulary, ~25 optional fields, status word normalisation | `lib/agent-sessions.js:75-150` | Renamed fields become `null` silently (no tokens, no status, no parent); a status word outside the list maps to `''`; sessions of a non-`main` agent id are dropped by design. Feeds Sessions graph, events and spend alarms. |
| 12 | `modelInput` per version + `containerVersionSync` (image tag, else `/root/.openclaw/.last-version`) | `lib/agent-versions.json`, `lib/agent-versions.ts:58-75`, `app/api/gateway/sync.ts:50-89` | A value a release does not know invalidates the agent's whole generated catalogue ("model catalog load issue") with no error to Rev4a; the version file is written by Rev4a's entrypoint from `openclaw --version` text. |
| 13 | Cron list JSON: strict `JSON.parse(raw.trim())` on the Crons page; `name ?? id` comparison of all jobs (OpenClaw built-ins included) in update verification | `lib/openclaw-cron.ts:173-184,321`, `lib/agent-update.ts:121-130,163-175` | A banner line marks every agent "did not answer"; a release that renames/removes a built-in job fails every update as "cron jobs missing". |
| 14 | `openclaw --version` text parsed with `VERSION_RE` and a second regex | `lib/agent-versions.ts:77-84`, `lib/credentials/native.ts:338-340`, `lib/agent-images.ts:174-176`, `lib/agent-update.ts:509`, `agent-templates/base-image/entrypoint.sh:35-40` | Gates update, rollback verification, credential delivery floors and the entrypoint's `doctor --fix`. Format change → "unknown version": updates refused, credentials refused, and (entrypoint) `doctor --fix` re-runs on every boot if the text is unstable. |
| 15 | Memory: recreates carry existing caps; Create/Update now check exact-target resource policy and Docker headroom before mutation; CLI reads still run inside the cap | `lib/agent-resource-policy.js:9-28`; `lib/agent-resource-preflight.ts`; `lib/agent-update.ts:226`; `lib/agent-recreate.ts` | Exact10.10 requires a4 GiB finite cap after2/3 GiB failures. Larger workloads can still exceed it; no silent cap/default change. Retain Docker OOM evidence even when restarted inspect counters reset (B32, section C). |

Next in line (were #10 and #15 before 2026-11-05): `pairing approve` success by text heuristic and strict `pairing list` parse (C14, C15, T2: `lib/channelManager.ts:422-466`); Codex app-server and GitHub handoff cleanups that fail silently (P16, T3: `lib/subscriptions-parse.js:312-322`, `lib/credentials/managed.ts:156-162`).

---

## 1. CLI commands

Rev4a's Gateway CLI calls use `gatewayCliArgv` or `gatewayShellScript` (`lib/gateway-cli.ts`), with a local copy `COSTS_GATEWAY_CLI` in `daemon.js`. They read the current token from `/root/.agent-token` inside the container and fall back to the container's token environment. `gatewayCliArgv` defaults to `OPENCLAW_GATEWAY_PORT=3000`, or leaves the address to an explicit `OPENCLAW_GATEWAY_URL`. Shell callers set the address when needed. Docker exec uses in-container `timeout -k 5 N` (`lib/exec-timeout.js`).

| ID | Touchpoint | Call sites (file:line) | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| C1 | `openclaw gateway call <method> --json --timeout <55000> --params <json>` | `daemon.js:923-929` (callers 1007, 1008, 1146, 1273) | Costs page, Sessions page, spend alarms (daemon collectors) | Exit≠0 → `failureReason` (stored in `agent_cost_sources.error`, daemon log); `--timeout` / `--params` flag rename → every collection fails (loud in log, stale data in UI) | none (test-gateway-cli covers lib copy only; daemon copy kept "identical" by comment, `lib/gateway-cli.ts:12-13`) | — |
| C2 | `openclaw cron list --json --all` (also `--all --json`) | `lib/openclaw-cron.ts:197-201`; `lib/agent-update.ts:121-130` | Crons page, system-health "Cron jobs", update baseline/verification | Crons: output must be pure JSON (strict parse) else agent listed as "did not answer" (loud-ish). Update: unreadable → `null` → verification error "cron job list could not be read" (loud) | none | — |
| C3 | `openclaw cron enable|disable <jobId>` | `lib/openclaw-cron.ts:212-226` | Crons page toggle (`app/api/crons/[id]/route.ts`) | Any exit 0 counts as success (output ignored); rename → "Failed to toggle" (loud) | test-cron-ids.mjs (id validation only) | — |
| C4 | `openclaw cron runs --id <jobId> --limit <N>` | `lib/openclaw-cron.ts:319`; `daemon.js:1257-1268` | Crons page run history; Sessions page cron-run rows | UI: strict `JSON.parse` → "Cannot connect to container gateway for runs" (misleading). Daemon: tolerant (`indexOf('{')`), throws and backs off per job (log only) | test-agent-sessions.mjs (parseCronRuns/mapCronRun) | — |
| C5 | `openclaw cron remove <jobId>` | `lib/openclaw-cron.ts:359-372` | Crons page delete | Exit 0 = success | none | — |
| C6 | `openclaw config patch --stdin` (merge patch on stdin) | `lib/agent-setup.ts`; `app/api/gateway/sync.ts`; `lib/subscriptions.ts`; `lib/subscription-claude.ts`; `lib/claude-lean-tools.ts`; `lib/credentials/native.ts` (150 s; timeout read-back checks the config file); image defaults in `agent-templates/base-image/entrypoint.sh` and `Dockerfile` | Runtime config guarantees (create/recreate/update/edit), provider sync per agent, subscription model switch, credential skill entries, image defaults | Refusal is reported by sync, subscriptions and credentials. Runtime config and the entrypoint log failures. Credential patch timeouts read the config file directly: matching keys continue, otherwise a clear slow-reload retry error. Merge semantics are a separate assumption (B1) | test-gateway-cli-coverage.mjs, test-credentials-native.mjs, test-agent-config-lock.mjs, test-claude-lean-tools.mjs, test-subscription-claude.mjs | Rev4a patches reach the Gateway on 2026.10.x and use `gatewayCliArgv`. Image defaults are applied before the Gateway starts. |
| C7 | `openclaw --version` | `lib/agent-images.ts:174-176`; `lib/agent-update.ts:509`; `lib/credentials/native.ts:130,338-340`; `agent-templates/base-image/entrypoint.sh:35` | Agents list version (images without label), rollback check, credential version floor, entrypoint migration trigger | Text parsed by regex (see T4). Unparseable → null → "unknown version" | test-image-revisions.mjs (parseOpenClawVersion), test-credentials-native.mjs (supportsNative) | agent-versions.ts:79 example `OpenClaw 2026.9.3 (1391f7c)` |
| C8 | `openclaw doctor --fix --non-interactive` | `agent-templates/base-image/entrypoint.sh:39` | Schema migration on version change (update flow depends on it) | Failure only logged; gateway still starts and refuses old schema → update fails at readiness (loud, slow) | none | entrypoint.sh:27-30 "From 2026.9.x the agent database schema is migrated only by `doctor --fix`" |
| C9 | `openclaw gateway --bind lan --port 3000 --auth token [--token X] --allow-unconfigured` | `agent-templates/base-image/entrypoint.sh:124,133`; `Dockerfile:133` (CMD, overridden) | Every agent start | Flag rename → container crash-loops (loud: create timeout + rollback) | test-gateway-auth-entrypoint.mjs | entrypoint.sh:113-114 "Agents still on OpenClaw 2026.9.3, or on a 2026.9.9 image built before 384bd8e, keep using --token" |
| C10 | `openclaw devices list --json` | `lib/agent-devices.ts:207-218` (via `/api/agents/[id]/devices`, `/api/agents/devices-summary`) | Agent panel Browser access, Agents page pending-approval badge | Tolerant JSON slice; missing `pending`/`paired` → empty lists (**silent**) | none | agent-devices.ts:12 "Browser approval is part of OpenClaw 9.x" |
| C11 | `openclaw devices approve <requestId> --json`, `devices reject <requestId> --json`, `devices remove <deviceId> --json`, `devices rename --device <id> --name <n> --json` | `lib/agent-devices.ts:220-235` | Browser access actions | Output must contain a JSON document (else "OpenClaw returned no JSON", loud); content not checked | none | — |
| C12 | `openclaw dashboard --json` | `lib/agent-devices.ts:246-270,313-328` | "Open" Control UI (one-time link) | `ok!==true`/no `browserUrl` → falls back to plain `#token=` link (**silent degrade**: browser then needs approval) | none | — |
| C13 | `openclaw plugins list --json` (no gateway) | `lib/agent-plugins.ts:8`; `app/api/plugins/route.ts:48` | Plugins page | No object with `plugins[]` → loud error; error text regexes classify (T5) | test-agent-plugins.mjs | — |
| C14 | `openclaw pairing list --channel <ch> --json` (argv) | `lib/channelManager.ts`, `getPairings` | Telegram pending pairing requests | Missing/malformed/partial output reports error while retaining readable approved results | test-channel-pairing.mjs, test-gateway-cli-coverage.mjs | Reaches the Gateway on 2026.10.x and uses `gatewayCliArgv`. |
| C15 | `openclaw pairing approve <ch> <code> 2>&1` (shell) | `lib/channelManager.ts`, `approvePairing` | Telegram approve | Text heuristic (T2) | test-channel-pairing.mjs, test-gateway-cli-coverage.mjs | Reaches the Gateway on 2026.10.x and uses `gatewayShellScript`. |
| C16 | `openclaw models list --provider openai --json` | `lib/subscriptions.ts:415-431` | Subscriptions page model list, model panel ChatGPT group | `models[]` missing → `'unreadable'` thrown (loud) | test-subscriptions.mjs (parseModelList) | — |
| C17 | `timeout 900 script -e -qfc "openclaw models auth login --provider openai --device-code" /dev/null` | `lib/subscription-login.ts:57,186` | ChatGPT (Codex) sign-in | Text output parsed (T1); flag rename → login fails (loud) | test-subscriptions.mjs (parseDeviceLogin) | — |
| C18 | `timeout 60 openclaw gateway call models.authLogout --params <json> --json --timeout 55000` with `provider: 'openai'` and `profileIds` | `lib/subscriptions.ts:649-666` | ChatGPT subscription disconnect | Renamed RPC or missing IDs in `removedProfiles` → disconnect fails (loud). Rev4a then reads the profiles back to confirm removal. | test-subscription-logout-rpc.mjs | Verified on 2026.9.3 (npm dist), 2026.9.9 and 2026.10.10. |
| C19 | `timeout 120 openclaw status --usage --json` | `lib/subscription-usage.ts:46-58` | Subscriptions usage windows | Empty / no openai provider / no windows → `no usage` error per account (loud-ish) | test-subscriptions.mjs (parseUsageStatus) | comment: "11 to 50 s on a slow host, about 360 MB" |
| C20 | `openclaw secrets store set <NAME> --kind env --value-file -` (value on stdin) | `lib/credentials/native.ts`, `storeSetArgv` | Credentials switch-on (Supabase, Trello, Notion, MongoDB) | Non-zero → loud (redacted) | test-credentials-native.mjs, test-gateway-cli-coverage.mjs | Reaches the Gateway on 2026.10.x and uses `gatewayCliArgv`. The command also works wrapped on 2026.9.9, where the store is local. |
| C21 | `openclaw secrets store rm --yes <NAME>` | `lib/credentials/native.ts`, `storeRemoveArgv`; `lib/credentials/managed.ts`, `handoffRmArgv` and `sweepGithubHandoffs` | Credentials switch-off, handoff cleanup | `--yes` required: without it the CLI prompts, removes nothing and exits 0. A missing name is expected to exit 0. | test-credentials-native.mjs, test-credentials-managed.mjs, test-gateway-cli-coverage.mjs | Reaches the Gateway on 2026.10.x and uses `gatewayCliArgv` or `gatewayShellScript` for the sweep. The command also works wrapped on 2026.9.9. |
| C22 | `openclaw secrets store list` (human output, grepped) | `lib/credentials/managed.ts:156-162` | GitHub handoff sweep | Best effort, all errors swallowed (**silent**) | test-credentials-managed.mjs | — |
| C23 | `openclaw secrets reload` (gateway wrapper, `OPENCLAW_GATEWAY_URL=ws://127.0.0.1:3000`) | `lib/credentials/native.ts:109,121-129,314-320,352,374` | Credentials take effect without restart | 150 s per-step deadline; timeout reports an unconfirmed reload (no raw exec text), collected on disable | test-credentials-native.mjs | — |
| C24 | `openclaw skills info rev4a-mongodb --json` | `lib/credentials/mongodb.ts:46,173-192` | MongoDB credential switch-on check | Unreadable output → switch-on fails **and rolls back** the store/skill entries (loud, destructive to a working credential); timeout → no rollback. The shared skill `rev4a-mongodb` exists only after a MongoDB switch-on installs it (`lib/credentials/delivery.ts:352-356`, `ensureRev4aSkill`): on a test agent without that credential, `skills info rev4a-mongodb` answers "not found" before and after, and proves nothing | test-credentials-mongodb.mjs | native.ts:81 "2026.9.9 is the only release this was verified on" |
| skill-scripts | The commands this skill's own scripts run in a test agent: `openclaw cron add --command … --name …`, `cron add --name … --session … --light-context --no-deliver --model …`, `cron run <jobId>`, `agent --agent … --session-id … --message … --json --timeout …`, `skills list --json`, `channels status --channel … --json` | `skills/rev4a-openclaw-upgrade/scripts/seed.mjs`, `skills/rev4a-openclaw-upgrade/scripts/snapshot.mjs` | Not a Rev4a feature: the seed and the snapshots of this evaluation | A renamed subcommand or flag makes `seed.mjs` FAIL (exit 1) or a snapshot item fail on both sides (`compare.md` "failing in both"); `rev4a-deps.mjs` C3 lists it against TO's docs first | none | — |

## 2. Gateway RPC (`openclaw gateway call` / public Gateway SDK)

| ID | Touchpoint | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| R1 | `usage.cost` params `{agentScope:'all', startDate, endDate}` (UTC dates, 30-day window); also a one-day "wake" call | `daemon.js:998-1007,1142-1148` | Costs page, dashboard spend, system-health cost check, vendor reconciliation | See J1 — field renames → **silent zeros** over the window | none | daemon.js:837-841 "Measured on a VPS (2026-09-27): about 60 s to rebuild" |
| R2 | `sessions.usage` params `{agentScope:'all', startDate, endDate, limit:50}` | `daemon.js:1008` | Costs by model and most expensive sessions | See J2 — **silent zeros / unknown** | none | — |
| R3 | `sessions.list` params `{limit:200, archived:'all', offset?}`, up to 10 pages | `daemon.js:1270-1279`; `lib/agent-sessions.js:181-221` | Sessions graph (`agent_sessions`), session events, spend/loop alarms (`lib/spend-alerts.js`) | Shape checks throw (no write, logged); field renames → nulls (**silent**) | test-agent-sessions.mjs, test-spend-alerts.mjs | — |
| R4 | `secrets.store.set` params `{name:'github-setup-<32hex>', value, kind:'secret', allowedHosts:[]}`; `{method, params}` on stdin to `callGatewayFromCli` from `openclaw/plugin-sdk/gateway-runtime`, cwd resolved from the real `openclaw` executable; explicit Gateway URL/token, timeout `15000`, `json: true` | `lib/credentials/managed.ts:54-60,71-149,151-162` | GitHub PAT delivery (managed identity); PAT absent from argv/env/script on the SDK path | Loud (redacted); handoff removed on failure. Only import `ERR_MODULE_NOT_FOUND` / `ERR_PACKAGE_PATH_NOT_EXPORTED` or missing function emits our marker and selects legacy `gateway call --params`; one token-free warning per enable, PAT briefly visible in container argv on fallback, never env. RPC errors never select fallback | test-credentials-managed.mjs | SDK verified by orchestrator on 2026.9.9 and 2026.10.10; fallback preserves older agents (2026.9.3) |
| R5 | `tools.github.configure` params `{scope:'agent', agentId:'main', mode:'managed', secretName}` / `{…, mode:'inherit'}`; enable shares R4's stdin SDK helper and detected legacy fallback; disable keeps the CLI path | `lib/credentials/managed.ts:63-69,122-135,143,165-175` | GitHub identity on/off | Loud on enable; disable error collected | test-credentials-managed.mjs | — |

## 3. HTTP endpoints of the gateway / Control UI URL shape

| ID | Touchpoint | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| H1 | `GET http://127.0.0.1:3000/startupz` via `curl -w '\n%{http_code}'`: `ready` only for 200 + JSON `status==="started"`, 503 = starting | `lib/agent-readiness.ts:57-139`; callers `app/api/agents/create/route.ts:319`, `lib/agent-recreate.ts:249`, `lib/agent-edit.ts:94`, `lib/agent-update.ts:274,506,546`, `lib/credentials/delivery.ts:647`, `lib/subscription-login.ts:171`, `lib/gateway-status.ts:54`, `app/api/agents/[id]/open-control-ui/route.ts:64` | Create, recreate, edit, update, credential re-apply, login, Agents page state, Open Control UI | Never "ready" → **create removes the container and the volume it made**; others time out loudly | test-gateway-state.mjs (state machine only, not the probe) | agent-readiness.ts:17 "`/startupz` is the probe on every supported version (2026.9.x)" |
| H2 | `/startupz` body field `version` | `lib/agent-devices.ts:101-120,318`; `lib/agent-update.ts:142-149` | Browser approval required? one-time link; update "reports version X" check | Missing → `requiresApproval: null` ("unknown"), one-time link skipped (**silent degrade**); update fails "reports no version" after 3 retries (loud) | none | agent-devices.ts:100 "a 9.x Gateway" |
| H3 | Control UI plain link `http://<host>:<port>/#token=<token>`; one-time link `browserUrl` with fragment `gatewayUrl=` rewritten to the published port | `lib/agent-devices.ts:246-270,306-307,334-338` | Open / Invite Control UI | Wrong fragment name → browser lands unauthenticated (**silent**) | none | — |
| H4 | Gateway listens on 3000 (OpenClaw default 18789 kept as fallback); WS URL `ws://127.0.0.1:3000` | `lib/openclaw-cron.ts:187-194,214-217,312-315,361-364`; `lib/credentials/native.ts:121`; `lib/credentials/managed.ts:44`; `lib/agent-devices.ts:62`; `lib/agent-ports.ts:7-10` | Every CLI call to the gateway, port publishing | — (Rev4a sets `--port 3000`) | test-gateway-cli.mjs | agent-ports.ts:9 "OpenClaw shifts its derived ports (browser, canvas) from 3000" |

## 4. openclaw.json keys READ

| ID | Key | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| KR1 | `agents.defaults.model` (string or `{primary, fallbacks[]}`) | `lib/subscriptions-parse.js:209-213`; `app/api/agents/models-summary/route.ts:125-132`; `app/api/agents/[id]/model/route.ts:28-30`; `lib/credentials/runtime.ts:25-27`; `app/api/gateway/agent/route.ts:180-184` | Model chips, model panel, subscription state, Codex-runtime detection | Moved key → "unset" chip / null model (**silent**); subscriptions returns 502 on null | test-subscriptions.mjs | — |
| KR2 | `agents.list[id==='main'].model` | `lib/subscriptions.ts:511-521`; `lib/credentials/runtime.ts:26`; `app/api/gateway/agent/route.ts:165-178` | Model panel, Codex detection | Missing → falls back to defaults (**silent**). **`agents.list` is not in the 2026.9.9 or 2026.10.10 config schema** (`agents` = `ownership, defaults, entries`); OpenClaw's legacy rule says "agents.list moved to keyed agents.entries" (`doctor --fix` migrates it). On 9.9+ this branch never finds a list: see KR13 | none | schema checked 2026-11-05 on 9.9 and 10.10 |
| KR13 | `agents.entries.main.model` (and `agents.entries.<id>.model`) — **not read by Rev4a** | (absent) — readers of the per-agent model look only at KR2: `lib/subscriptions.ts:511-521`; `lib/credentials/runtime.ts:25-27`; `app/api/gateway/agent/route.ts:165-178` | Model chips, model panel, Codex detection | An agent whose `main` entry sets its own model (a migrated `agents.list`, or set by hand) runs that model while Rev4a shows and edits `agents.defaults.model` (**silent** wrong model, wrong Codex detection) | none | lead from the schema check, not reproduced on a live agent |
| KR3 | `models.providers.rev4a.models[].id` | `app/api/agents/[id]/model/route.ts:45-52`; `app/api/agents/models-summary/route.ts:136-140` | "resolvable" / `out-of-sync` model health | Moved → every agent "out-of-sync" (wrong data) | none | — |
| KR4 | `channels.telegram.{enabled, botToken, dmPolicy, allowFrom}` | `lib/channelManager.ts:109-121,159-167`; `app/api/agents/channels-summary/route.ts:56-57` | Telegram panel, Agents list Telegram badge | `botToken` as a SecretRef object or moved → "not connected" (**silent**) | none | — |
| KR5 | `bindings[]` `{agentId, match:{channel, accountId}}` | `lib/channelManager.ts:240-280` | Telegram binding to agent `main` | Shape change → duplicate/missing binding (**silent**) | none | channelManager.ts:236-246 cites "multi-agent.md" |
| KR6 | `gateway.controlUi.{allowedOrigins, dangerouslyDisableDeviceAuth}` | `lib/agent-setup.ts:155-166` | Control UI origin policy | Read failure throws, caught → console.warn (**silent**) | none | Dockerfile:67-68 "OpenClaw 9.x retired it [dangerouslyDisableDeviceAuth]" |
| KR7 | `gateway.auth.{token, password, mode}` | `agent-templates/base-image/rev4a-gateway-auth:21-24`; `app/api/agents/config-json/route.ts:49-51` (masks `token` only) | Entrypoint token mode; "View openclaw.json" | New auth key → token passed via env while config wins (agent token silently not in charge) | test-gateway-auth-entrypoint.mjs | — |
| KR8 | `agents.entries.main.tools.github.profileId` | `lib/credentials/detect.ts:152` | Credentials detect: managed GitHub identity | Moved → identity not found (**silent**) | test-credentials-detect.mjs | — |
| KR9 | `agents.defaults.bootstrapMaxChars`, `.bootstrapTotalMaxChars`, and `agents.entries.<k>.*` same keys | `lib/memory-context.ts:97-100,214-220` | Context (/memory) page caps | Renamed → defaults 20000/60000 shown (**wrong data**) | test-memory-context.mjs | memory-context.ts:16 "verified on 9.3 and 9.9" |
| KR10 | `plugins.load.paths`, `tools.web.search.provider`, `agents.defaults.heartbeat.every`, `agents.defaults.compaction.maxActiveTranscriptBytes`, `agents.defaults.contextPruning.mode` (presence checks) | `agent-templates/base-image/entrypoint.sh:64-84` | Image defaults applied when missing | Renamed key → default re-applied every boot or refused (log only) | none | — |
| KR11 | Whole file returned to the browser | `app/api/agents/config-json/route.ts:28-55`; `app/agents/PageClient.tsx:1346-1351` | "View openclaw.json" | Exposes any secret OpenClaw stores in config (see side findings) | none | — |
| KR12 | Whole file parsed then rewritten (read side of KW13) | `lib/channelManager.ts:59-67`; `app/api/gateway/agent/route.ts:148-162`; `app/api/agents/create/route.ts:370-374`; `app/api/gateway/sync.ts:190-226` | Telegram, model panel, create, Sync All | Non-JSON (e.g. JSON5/comments) → loud refusal (sync, model) or "Could not read" | none | — |
| KR13 | Archived `meta.lastTouchedVersion` | `lib/backup-inspection.ts`; `lib/backup-compatibility.ts`; `lib/backup-cron-evidence.ts` | Restore/source provenance, combined with actual schemas | Missing metadata uses known legacy schema evidence for restore; cron repair remains unresolved without exact source evidence | test-agent-restore-safety.mjs, test-backup-cron-evidence.mjs | — |

## 5. openclaw.json keys WRITTEN

| ID | Key / value | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| KW1 | `hooks.internal.entries.bootstrap-extra-files = {enabled:true, paths:['.rev4a/*.md']}` | `lib/agent-setup.ts:87-98`; `Dockerfile:87` | Rev4a rules injected in every session | Hook renamed → rules silently not injected; patch refusal only warned | none | — |
| KW2 | `skills.load.extraDirs = ['/data/.openclaw/shared-skills']` | `lib/agent-setup.ts:100-106`; `Dockerfile:84-85` | Shared skills (incl. `rev4a-mongodb`) | Key renamed → shared skills silently not loaded | none | — |
| KW3 | `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback = true`; `allowedOrigins: null` when `["*"]`; `dangerouslyDisableDeviceAuth: null` | `lib/agent-setup.ts:126-134,155-166`; `app/api/agents/create/route.ts:381-383`; `Dockerfile:75` | Control UI reachable on public IP | Key removed/renamed → Control UI refuses public origin (loud in browser, silent in Rev4a) | none | Dockerfile:67-68 |
| KW4 | `gateway.mode = "local"` | `Dockerfile:75` | Gateway runs locally | — | none | — |
| KW5 | `agents.defaults.model = {primary:'rev4a/<id>'|'openai/<id>', fallbacks[]}` | `app/api/agents/create/route.ts:386-400`; `app/api/gateway/agent/route.ts:180-188`; `lib/subscriptions.ts:303-315` | Model selection | Subscriptions re-reads and compares (loud); others write-only (`verifyRaw.includes('"primary"')`, route.ts:213) | test-subscriptions.mjs | gateway/agent route.ts:203-206 quotes `[reload] config hot reload applied (agents.defaults.model.primary)` |
| KW6 | `agents.list[id=main].model` (whole `agents.list` array sent, arrays replace) | `app/api/gateway/agent/route.ts:166-178`; `lib/subscriptions.ts:524-546` | Model panel, subscription switch | Re-read and compared in subscriptions (loud). Written only when a list with `main` exists, which no 9.9+ schema has (KR2): subscription disconnect skips it (`lib/subscriptions.ts:564-573`), so a subscription model set in `agents.entries.main.model` (KR13) would survive a disconnect (**silent**) | none | — |
| KW7 | `update = {checkOnStart:false, auto:{enabled:false}}` | `app/api/agents/create/route.ts:402-406` | Agents never self-update | Keys renamed → OpenClaw may self-update (silent; post-create errors swallowed `create/route.ts:421-423`) | none | — |
| KW8 | `models.providers.rev4a = {baseUrl, apiKey:r4a1.<agentId>.<mac>, api:'openai-completions', headers:{<AGENT_HEADER>:agentId}, models:[{id, name, input[], cost:{input, output, cacheRead, cacheWrite}}]}` | `app/api/gateway/sync.ts:92-112,261-288,318-336,467-494`; per-agent `config patch` (`patchRev4aProvider`): `app/api/agents/create/route.ts:435`, `lib/agent-recreate.ts:254`, `lib/agent-edit.ts:99`, `lib/agent-update.ts:283,588`; whole-file Sync All of **every** agent (`syncAllAgents`, B25, fleet FL1-FL3): `instrumentation.ts:25`, `lib/price-schedule-sync.ts:72`, `app/api/gateway/provider/route.ts:226` | Every model call (proxy), cost pricing, per-agent metering (derived token against historical known ids, including retained deleted ids; root rotation revokes all tokens until sync; compatibility `headers`, B26) | Schema change → catalogue invalid, agent cannot call models; `cost` all-zero = unpriced (B10) | none | `app/api/gateway/sync.ts:496-502` "Verified against a live agent" (reload) |
| KW9 | `channels.telegram = {...existing, enabled, botToken, dmPolicy, allowFrom?}`; disconnect sets `enabled:false`, deletes `botToken`/`allowFrom` | `lib/channelManager.ts:139-230` | Telegram connect/disconnect | Written as plaintext token; SecretRef migration would be overwritten | none | — |
| KW10 | `bindings[] += {agentId:'main', match:{channel, accountId:'default'}}`; removal by filter | `lib/channelManager.ts:247-280` | Telegram routed to `agent:main:main` | — | none | — |
| KW11 | `skills.entries.<name> = {enabled:true}` / `{enabled, apiKey:{source:'store', provider:'default', id}}` / `{enabled, env:{…plaintext}}`; `null` to remove. Names: `github`, `trello`, `notion`, `rev4a-mongodb` | `lib/credentials/native.ts:52-88,146-181` | Credentials skill switch-on | SecretRef shape change → skill not eligible (MongoDB checks with `skills info`; others **silent**) | test-credentials-native.mjs | native.ts:81 (2026.9.9) |
| KW12 | Image defaults: `plugins.load.paths += /opt/openclaw-plugins/node_modules/@openclaw/duckduckgo-plugin`, `tools.web.search.provider='duckduckgo'`, `agents.defaults.heartbeat.every='0m'`, `agents.defaults.compaction.maxActiveTranscriptBytes='20mb'`, `agents.defaults.contextPruning={mode:'cache-ttl', ttl:'1h'}` | `agent-templates/base-image/entrypoint.sh:46-96` | Web search, cost control defaults | Refused patch logged only (**silent**). OpenClaw's legacy web-search migration moves provider-owned settings to `plugins.entries.<plugin>.config.webSearch`; `tools.web.search.provider` itself is still in the 2026.10.10 schema | none | schema checked 2026-11-05 (9.9, 10.10) |
| KW13 | Full-file overwrite (`cat > openclaw.json` / tmp+mv / `docker cp` when stopped) | `lib/channelManager.ts:69-79`; `app/api/gateway/agent/route.ts:192-196`; `app/api/agents/create/route.ts:411-415`; `app/api/gateway/sync.ts:228-250` | Telegram, model panel, create, Sync All | Bypasses `config patch` validation; relies on B2 | none | see B2 |

## 6. File / directory paths (volume or image)

| ID | Path | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| P1 | Volume `agent-<id>-data` mounted at `/root` (OpenClaw state = `$HOME/.openclaw`, image runs as root) | `lib/agent-create-args.ts:23`; `lib/agent-recreate.ts:164` | Persistence across recreate/update | State outside `/root` lost on recreate (silent data loss) | test-agent-volumes.mjs | Dockerfile:7-10 |
| P2 | `/root/.openclaw/openclaw.json` | channelManager.ts:61,76; agent-setup.ts:156; sync.ts:471; gateway/agent/route.ts:148,194,212; create/route.ts:372,413; [id]/model/route.ts:72; models-summary/route.ts:32; channels-summary/route.ts:16; config-json/route.ts:29; subscriptions.ts:51; subscriptions-parse.js:209; credentials/runtime.ts:19; credentials/detect.ts:152; credentials/native.ts:114,307; memory-context.ts:14; rev4a-gateway-auth:15; entrypoint.sh:69 | Nearly every config feature | Moved → reads empty/"could not read" (mixed loud/silent per KR rows) | several | — |
| P3 | `/root/.openclaw/.last-version` (written by Rev4a entrypoint with `openclaw --version` text) | `app/api/gateway/sync.ts:58,66-89`; `entrypoint.sh:36-40` | modelInput per version; migration trigger | — (Rev4a-owned file inside OpenClaw dir) | none | — |
| P4 | `/root/.openclaw/state/openclaw.sqlite` | `lib/subscriptions-parse.js:189`; `lib/credentials/detect.ts:150`; (indirectly) `lib/channelManager.ts:307` | Subscriptions, credentials detect, pairing store | Missing → `unsupported` / `store-ok` empty (**silent**) | test-subscriptions.mjs, test-credentials-detect.mjs | channelManager.ts:307 "On 2026.9.3 …" |
| P5 | `/root/.openclaw/agents/<agent>/sessions/*.jsonl` (skips `.trajectory.jsonl`) | `lib/agent-update.ts:79-88` | Update verification | see top-15 #4 | none | — |
| P6 | `/root/.openclaw/agents/<agent>/session-sqlite-import-archive/archive-tier.<id>.jsonl.imported-<ts>` | `lib/agent-update.ts:89-96` | Update verification | see top-15 #4 | none | agent-update.ts:66-70 "where 9.x moves the old `.jsonl` files … seen on the VPS" |
| P7 | `/root/.openclaw/agents/<agent>/agent/openclaw-agent.sqlite` | `lib/agent-update.ts:97-107` | Update verification | see S3 | none | — |
| P8 | `/root/.openclaw/agents/main/agent/models.json`, `/root/.openclaw/agents/main/agent/auth-profiles.json` (deleted) | `app/api/gateway/sync.ts:476-486` | "Clean up stale files from old versions" on Sync All | top-15 #9 (**silent destructive**) | none | — |
| P9 | `/root/.openclaw/credentials/github/agents/<hash>/<profileId>/hosts.yml` | `lib/credentials/detect.ts:136-139,153` | Credentials detect (GitHub) | **silent** | test-credentials-detect.mjs | — |
| P10 | `/root/.openclaw/workspace` (+ `skills/`, `TOOLS.md`, `memory/`, bootstrap files) | `lib/workspace-fs.ts:13`; `lib/memory-context.ts:11`; `app/workspace/WorkspaceClient.tsx:64`; `app/workspace/url-state.ts:9`; `app/api/agents/create/route.ts:336-362`; `app/api/skills/route.js:15`; `app/api/skills/delete/route.js:48`; `app/api/skills/promote/route.js:76,92,118`; `lib/credentials/delivery.ts:138`; `lib/credentials/detect.ts:182`; templates (`rev4a-rules/AGENTS.md:9`, `agent-templates/*/AGENTS.md:5`) | Workspace page, Context page, templates seeding, workspace skills, TOOLS.md | Moved → pages empty / templates in the wrong dir (**silent**). Templates copy their bootstrap files into it (`app/api/agents/create/route.ts:336-362`): `atlas` ships `HEARTBEAT.md`, `custom` ships `BOOTSTRAP.md`; both rely on OpenClaw's bootstrap and first-run handling (section A). Daily memory (`MEMORY.md`, `memory/*.md`) is read as plain files: a release that keeps it elsewhere leaves the Workspace and Context pages stale | test-workspace-*.mjs, test-memory-context.mjs | — |
| P11 | `/root/.openclaw/workspace/.rev4a` (read-only bind mount of rev4a-rules) | `lib/agent-setup.ts:38-42`; `lib/memory-context.ts:27` | Rules file for the bootstrap hook | A mount **inside** the workspace: OpenClaw must never write, clean or `git init` there. A release that does fails that operation (read-only file system) — doctor, a workspace tool, or a cleanup pass (B29) | none | — |
| P12 | `/data/.openclaw/shared-skills` (read-only bind mount) | `lib/agent-setup.ts:33-37,103`; `Dockerfile:84-85` | Shared skills | — | none | — |
| P13 | `/usr/local/lib/node_modules/openclaw/skills` (bundled skills) | `app/api/skills/route.js:14,178-196` | Skills page bundled list | npm prefix / layout change → bundled list empty (**silent**). The Skills page lists only three sources: the host shared dir (`app/api/skills/route.js:134-148`), each agent's `workspace/skills` (`:150-170`) and this bundled dir, read from the first agent that answers (`:178-198`). It never lists managed `~/.openclaw/skills`, skills shipped inside plugins, or skills a release learns or archives on its own: those are invisible on the page | none | — |
| P14 | `/usr/lib/node_modules/openclaw/skills` (bundled-skill read-only guard) | `app/api/skills/save/route.js:12,97,154` | Refuse edits of bundled skills | **Already mismatched** with P13 (`/usr/local/lib`): guard never matches the real path (side finding) | none | — |
| P15 | `/usr/local/lib/node_modules/openclaw`, its `package.json` export map and `dist` | `lib/channel-pairing-store.js` | Pairing SDK/private fallback resolution | see I1/I5; missing paths fail explicitly | test-channel-pairing.mjs | — |
| P16 | `/root/.openclaw/npm/projects/openclaw-codex-*/node_modules/@openai/codex*` (process cmdline) | `lib/subscriptions-parse.js:312-322`; `lib/subscriptions.ts:596` | Stop Codex runtime after sign-out | **silent** | test-subscriptions.mjs | subscriptions-parse.js:315 "Verified on OpenClaw 2026.9.3 (2026-10-09)" |
| P17 | `./.openclaw/openclaw.json` must be inside every backup archive | `lib/cold-backup.ts:82` | Cold backup verification (required by update) | Config moved → every backup fails "holds no .openclaw/openclaw.json" (loud; blocks updates). The archive is the whole volume minus `.npm/_cacache` only (`lib/cold-backup.ts:76,81`), and the backups folder must have free space of at least 60% of that size (`:76-79`). New OpenClaw caches and `doctor --fix` copies (`*.pre-startup-migration-*.bak`, never cleaned) grow every later backup and every update's space need | none (no test greps this path) | — |
| P18 | `/root/.openclaw/agents/main/agent/` directory: holds P7 (`openclaw-agent.sqlite`) and the two files P8 deletes (`models.json`, `auth-profiles.json`) | `app/api/gateway/sync.ts:476-486`; `lib/agent-update.ts:97-107` | Sync All cleanup, update verification | A release that puts live state back in either P8 file loses it at the next Sync All (B25, **silent**). A snapshot listing the volume to depth 3 never reaches this directory: list it explicitly to see a P8 file appear | none | — |

## 7. SQLite tables / columns read inside the container (`node:sqlite`, `readOnly`)

| ID | Table / query | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| S1 | `openclaw.sqlite`: `SELECT value_json FROM config_machine_state WHERE state_key='authProfiles.store'` → JSON `{profiles:{<id>:{type, provider, email, expires, chatgptPlanType, access, refresh}}}` | `lib/subscriptions-parse.js:139-142,181-216` | Subscriptions (connected accounts, plan, expiry), login pre-check, model switch guard | "no such table" → `unsupported`; supported image → "still starting" forever (loud but misleading); field rename → **silent** nulls | test-subscriptions.mjs (fixtures) | subscriptions-parse.js:175 "where 2026.9.x keeps it" |
| S2 | `openclaw.sqlite`: `sqlite_master` check, then `SELECT name, value, kind FROM secret_store_entries WHERE deleted_at_ms IS NULL` | `lib/credentials/detect.ts:150-151` | Credentials detect (installed/drift) | Table missing → **silent** empty; column rename → no `store-ok` → probe incomplete | test-credentials-detect.mjs | — |
| S3 | `openclaw-agent.sqlite`: `sqlite_master` check, `SELECT session_id, COUNT(*) FROM transcript_events GROUP BY session_id` | `lib/agent-update.ts:97-107` | Update verification | see top-15 #4 | none | — |
| S4 | `channel_pairing_allow_entries` read only through native I1/I5, never by SQL | `lib/channel-pairing-store.js` | Telegram approved senders | see I1/I5 | test-channel-pairing.mjs | — |
| S5 | Archived core databases: `PRAGMA user_version`, SQLite integrity and WAL state | `lib/backup-inspection.ts`; `lib/backup-sqlite-worker.js`; `lib/backup-compatibility.ts` | Restore compatibility before mutation | Unknown/newer/corrupt evidence refuses restore; core markers alone cannot certify private plugin downgrade safety | test-agent-restore-safety.mjs | Evaluated core generations: 9.3 state16/agent19; 9.9 state19/agent24; 10.10 state22/agent27 |
| S6 | Archived state `cron_jobs.job_json`, complete identity/declaration/agent inventory | `lib/backup-sqlite-worker.js`; `lib/backup-cron-evidence.ts` | Conservative repair of old name-only cron failures | Missing/malformed/incomplete source stays unresolved; never query a live agent volume or rewrite original verification | test-agent-restore-safety.mjs, test-backup-cron-evidence.mjs | — |

## 8. OpenClaw internal module / process / package

| ID | Touchpoint | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| I1 | `dist/pairing-store-*.mjs`, functions named `removeChannelAllowFromStoreEntry` and legacy fallback `readChannelAllowFromStoreSync`; native writer returns `{changed}` | `lib/channel-pairing-store.js`, `lib/channelManager.ts` | Private removal/clear and legacy approved-list fallback | Operation-specific unsupported/error; clear must verify empty before config mutation. A read no longer requires a remover | test-channel-pairing.mjs | Legacy 9.3 path; public reader preferred on 9.9/10.10 |
| I2 | npm package `@openclaw/duckduckgo-plugin@${OPENCLAW_VERSION}` with `openclaw.plugin.json` | `Dockerfile:98-101`; `entrypoint.sh:63,75-79` | Key-free web search | Not published at that exact version → **image build fails** | none | — |
| I3 | Codex app-server processes `@openai/codex` (P16) | `lib/subscriptions-parse.js:319-322` | Sign-out cleanup | **silent** | test-subscriptions.mjs | 2026.9.3 |
| I4 | `models auth login … --device-code` process cmdline (to kill) | `lib/subscription-login.ts:64-66,183,312` | Cancel/expire login | Cmdline change → orphan login process (bounded by `timeout 900`) | none | — |
| I5 | Public `openclaw/plugin-sdk/channel-pairing` package export, async `readChannelAllowFromStore(channel)` | `lib/channel-pairing-store.js` | Approved Telegram senders; clear pre/post read | Missing public capability uses the legacy fallback; a failing imported reader is an error. Resolve from the global OpenClaw package itself, not a bare host import | test-channel-pairing.mjs | Saved 9.9/10.10 exports; updated live read/revoke/clear passes using synthetic entries; real channel delivery remains separate |

## 9. Env vars / CLI flags

| ID | Touchpoint | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| E1 | `OPENCLAW_GATEWAY_TOKEN` (container env; gateway auth; CLI auth) | `app/api/agents/create/route.ts:273`; `lib/agent-recreate.ts:27` (`OPENCLAW_` env kept); `entrypoint.sh:15,123`; `lib/gateway-cli.ts:18`; `daemon.js:853`; `lib/agent-devices.ts:290`; `lib/redact-secret.ts:15` | Gateway auth everywhere | Renamed → CLI calls refused "gateway token mismatch" (loud) | test-gateway-cli.mjs, test-agent-token-redaction.mjs | — |
| E2 | `OPENCLAW_GATEWAY_PORT` | `lib/gateway-cli.ts:27`; `daemon.js:852` | CLI targets port 3000 | Ignored → CLI tries 18789 → all gateway calls fail (loud) | test-gateway-cli.mjs | — |
| E3 | `OPENCLAW_GATEWAY_URL` (`http://127.0.0.1:3000`/`:18789`, `ws://127.0.0.1:3000`) | `lib/openclaw-cron.ts:21,200`; `lib/credentials/native.ts:121`; `lib/credentials/managed.ts:44,116,169` | Cron, secrets reload, GitHub RPCs | Same as E2 | test-credentials-native.mjs | — |
| E4 | CLI flags relied on: `--json`, `--stdin`, `--all`, `--id`, `--limit`, `--params`, `--timeout`, `--provider`, `--device-code`, `--yes`, `--kind env`, `--value-file -`, `--channel`, `--device`, `--name`, `--fix --non-interactive`, `--bind lan --port --auth token --token --allow-unconfigured` | see C1-C24 | all | "unknown option" → loud except where NoFail swallows (cron list, pairing list) | partial | — |
| E5 | `npm install -g … --allow-scripts=openclaw` | `Dockerfile:60-69` | Complete OpenClaw install | Without it "the OpenClaw install is silently incomplete" (Dockerfile:60-62) | none | npm 11.16+ |
| E6 | `REV4A_OPENCLAW_CONFIG` (test hook for config path) | `agent-templates/base-image/rev4a-gateway-auth:12-15` | Tests | — | test-gateway-auth-entrypoint.mjs | — |

## 10. Output JSON fields Rev4a parses

| ID | Source | Exact fields read | Call sites | Failure mode | Test |
|---|---|---|---|---|---|
| J1 | `usage.cost` | `ok`, `cacheStatus.status` (`fresh` or absent = store), `daily[].{date, input, output, cacheRead, cacheWrite, totalTokens, totalCost, inputCost, outputCost, cacheReadCost, cacheWriteCost, missingCostEntries}`, `totals.missingCostByModel` | `daemon.js:982-1052` | **Silent zeros** replace the 30-day window (window deleted first) | none |
| J2 | `sessions.usage` | `ok`, `cacheStatus.status`, `aggregates.modelDaily[].{date, provider, model, tokens, cost, count}`, `sessions[].{sessionId, key, label, agentId, modelProvider, model, updatedAt, usage.{sessionId, totalTokens, totalCost, missingCostEntries, firstActivity, lastActivity}}` | `daemon.js:992-1046` | **Silent zeros / 'unknown'**; sessions without id skipped | none |
| J3 | `sessions.list` page | `ok`, `sessions[]`, `hasMore`, `nextOffset`, `totalCount` (`count` ignored) | `lib/agent-sessions.js:161-221` | Throws (nothing written, logged); missing `totalCount` → never marks sessions gone (**silent**) | test-agent-sessions.mjs |
| J4 | `sessions.list` row | `key`, `spawnedBy`, `parentSessionKey`, `sessionId`, `classification`, `spawnDepth`, `label`, `displayName`, `status`, `abortedLastRun`, `hasActiveRun`, `lastRunError`, `model`, `modelProvider`, `provider`, `inputTokens`, `outputTokens`, `totalTokens`, `contextTokens`, `estimatedCostUsd`, `startedAt`/`createdAt`/`sessionStartedAt`, `updatedAt`/`lastActivityAt`, `endedAt`, `archivedAt` | `lib/agent-sessions.js:122-155` | **Silent nulls**; `contextTokens` feeds spend alarms (`lib/spend-alerts.js`) | test-agent-sessions.mjs, test-spend-alerts.mjs |
| J5 | `cron runs` | `ok`, `entries[].{sessionId, action ('finished'), sessionKey, runAtMs, durationMs, ts, usage.{input_tokens|input, output_tokens|output, total_tokens|total|totalTokens}, completionStatus, status, error, model, provider}`; UI also `summary`, `diagnostics.summary`, `nextRunAtMs` | `lib/agent-sessions.js:224-275`; `lib/openclaw-cron.ts:279-331`; `app/crons/PageClient.tsx:512` | Daemon: entries without `sessionId` dropped (**silent**); UI: strict parse | test-agent-sessions.mjs; upgrade snapshots use `cli.cron-runs-agent` for usage/model/session fields |
| J6 | `cron list` | Plain array or complete `{jobs[]}`; identity/name/agentId/declarationKey; schedule, state, payload, delivery; optional failure/pagination indicators | `lib/openclaw-cron.ts`; `lib/agent-update-cron.ts`; `lib/agent-update.ts` | Update requires valid complete identity inventory; rejects explicit errors/partial pages and protects user/unknown declared jobs | test-openclaw-contracts.mjs, test-agent-update-cron.mjs |
| J7 | `devices list` | `pending[].{requestId, deviceId, displayName, platform, clientId, clientMode, roles|role, scopes, remoteIp, browserOrigin, isRepair, ts}`; `paired[].{deviceId, operatorLabel, displayName, platform, clientId, clientMode, roles|role, scopes, remoteIp, approvedVia, createdAtMs, approvedAtMs, tokens[].lastUsedAtMs, lastSeenAtMs, lastConnectedAtMs}` | `lib/agent-devices.ts:165-217` | Rows without `requestId`/`deviceId` dropped → empty list (**silent**) | none |
| J8 | `dashboard --json` | `ok`, `browserUrl` (fragment `gatewayUrl`), `reason`, `browserBootstrapExpiresAtMs` | `lib/agent-devices.ts:251-269` | Falls back to token link (**silent**) | none |
| J9 | `plugins list --json` | `plugins[].{id, name, version, description, enabled, status, origin, toolNames[], hookNames[], channelIds[], providerIds[]}` | `lib/agent-plugins.ts:48-66,106-121` | Counts 0 / blanks (**silent**); no `plugins[]` → loud | test-agent-plugins.mjs |
| J10 | `pairing list --json` | `requests[].{code|id,senderId}` | `lib/channelManager.ts`, `getPairings` | Malformed/unreadable reports explicit error; no invented empty-success | test-channel-pairing.mjs |
| J11 | `models list --json` | `models[].{key, name, contextWindow}` | `lib/subscriptions-parse.js:75-86` | Loud (`unreadable`) | test-subscriptions.mjs |
| J12 | `status --usage --json` | `usage.updatedAt`, `usage.providers[].{provider==='openai', accountEmail, plan, windows[].{label, usedPercent, resetAt}}` | `lib/subscriptions-parse.js:218-249`; `lib/subscription-usage.ts:56-58` | `no usage` error (loud-ish) | test-subscriptions.mjs |
| J13 | `skills info --json` | `eligible` (boolean), `missing` (array or object of arrays), `modelVisible` | `lib/credentials/mongodb.ts:62-103` | null → switch-on fails and rolls back | test-credentials-mongodb.mjs |
| J14 | `/startupz` | `status` (`started`), `version` | `lib/agent-readiness.ts:100-112`; `lib/agent-devices.ts:104`; `lib/agent-update.ts:145` | see H1/H2 | test-gateway-state.mjs (partial) |
| J15 | `gateway call` error | `{ok:false, error:{message}}` or `error` string on stdout, exit 1 | `daemon.js:859-880` | Falls back to stderr last line | none |
| J16 | Auth-profile store entry (S1) | `type`, `provider`, `email`, `expires` (ms), `chatgptPlanType`; id prefix `openai:`, `type==='oauth'` | `lib/subscriptions-parse.js:139-142`; `lib/subscriptions.ts:200` | **Silent** | test-subscriptions.mjs |
| J17 | Proxy request and answer (`/api/provider/v1/chat/completions`, `api:'openai-completions'`) | Request: OpenClaw's body forwarded upstream with `model` set, `provider`, `models`, `route`, `preset` removed and, when `stream === true`, `stream_options.include_usage:true` forced. Answer: `usage.{prompt_tokens|input_tokens, completion_tokens|output_tokens, prompt_tokens_details.cached_tokens|prompt_cache_hit_tokens|cached_tokens}`, in the JSON body or the last SSE `data:` chunk carrying `"usage"` | `app/api/provider/upstream.ts:126-145`; `lib/proxy-usage.js:128-190`; `lib/spend-alerts.js:219-227` (`ruleLoop`) | A new request field a vendor refuses fails every call at the proxy (loud for the agent); an answer without a usage block counts as `no_usage`, and `errors + no_usage` over half of an hour's calls raises a false `spend.loop` alarm (**silent** wrong figures) | none |

## 11. Log lines / text patterns matched

| ID | Pattern | Call sites | Rev4a feature | Failure mode | Test |
|---|---|---|---|---|---|
| T1 | Device login: `https://auth.openai.com/codex/device`, `/(?<![A-Za-z0-9])([A-Z0-9]{4}-[A-Z0-9]{5})(?=[\s\S])/` after the URL, `/expires in (\d+) minutes?/i`, `/OpenAI device code complete/i`, `/OpenAI device code failed/i`, `/timed out/i`; ANSI stripped | `lib/subscriptions-parse.js:9-53` | ChatGPT sign-in | No code / never done (top-15 #7) | test-subscriptions.mjs |
| T2 | `pairing approve`: success iff output non-empty and `!out.includes('error')` | `lib/channelManager.ts:458-466` | Telegram approve | False success (**silent**) | none |
| T3 | `secrets store list` grepped for `github-setup-[a-f0-9]\{32\}` | `lib/credentials/managed.ts:158` | Handoff sweep | **Silent** leftover | test-credentials-managed.mjs |
| T4 | Version text: `VERSION_RE = /(\d{4})\.(\d{1,2})\.(\d{1,2})(?:-(\d+))?/`; credentials `/(\d{4}\.\d{1,2}\.\d{1,2})/`; `majorMinor` `/^(\d+)\.(\d+)(?:\.|$|-)/`; entrypoint compares the whole `--version` string with `.last-version` | `lib/agent-versions.ts:77-98`; `lib/credentials/native.ts:212-220,338-340`; `lib/subscriptions-parse.js:357-366`; `entrypoint.sh:35-37` | All version gates | "unknown version" (loud refusals) | test-image-revisions.mjs, test-credentials-native.mjs, test-subscriptions.mjs |
| T5 | Plugins errors: `/unknown command|unknown option|too many arguments|invalid command|executable file not found|failed to run command|No such file or directory/i` | `lib/agent-plugins.ts:163-174` | Plugins page message | Wrong message only | test-agent-plugins.mjs |
| T6 | STATUS_SCRIPT: `/no such table/i`, `/locked|busy/i`, error codes `ERR_UNKNOWN_BUILTIN_MODULE`/`MODULE_NOT_FOUND` | `lib/subscriptions-parse.js:196,206,329-336` | Subscription status classification | Misclassified failure | test-subscriptions.mjs |
| T7 | Archive file name `/^archive-tier\.(.+?)\.jsonl\.imported-\d+$/`; `.trajectory.jsonl` skipped | `lib/agent-update.ts:84,91-94` | Update verification | Not counted (top-15 #4) | none |
| T8 | Session keys: `^agent:main:`, `^agent:[^:]+:cron:([^:]+)`, `…:cron:<id>$`, `…:cron:<id>:run:<id>$`; kinds `main`, `subagent`, `cron`, `cron_run`, `dashboard`, `explicit`, else `direct`; synthesised `agent:main:cron:<jobId>:run:<sessionId>` | `lib/agent-sessions.js:75-106,243-246` | Sessions graph, cron-run linking, events | Rows dropped / wrong kind (**silent**) | test-agent-sessions.mjs |
| T9 | Status words → `running|done|failed|aborted|''` (`done, completed, complete, ok, success, succeeded`; `failed, error, timeout, timed_out`; `aborted, killed, cancelled, canceled`) | `lib/agent-sessions.js:107-117,257-258` | Session state, events | Unknown word → `''` (**silent**) | test-agent-sessions.mjs |
| T10 | Cron `state.lastStatus` `'ok'` / `'error'` → pill colour | `app/crons/PageClient.tsx:457-460` | Crons page | Neutral pill (**silent**) | none |
| T11 | Process cmdlines: `*/openclaw-codex-*/node_modules/@openai/codex*`; `*"models auth login --provider openai --device-code"*` | `lib/subscriptions-parse.js:319-322`; `lib/subscription-login.ts:64-66` | Codex stop, login kill | **Silent** | test-subscriptions.mjs (STOP_CODEX_SCRIPT) |
| T12 | Model write verified by `verifyRaw.includes('"primary"')` | `app/api/gateway/agent/route.ts:212-214` | Model panel | Always true once any primary exists (weak check) | none |
| T13 | gh `hosts.yml`: `/^\s*oauth_token:\s*(.+?)\s*$/`, `/^\s*user:\s*(\S+)\s*$/` | `lib/credentials/detect.ts:148` | Credentials detect (GitHub identity written by OpenClaw) | **Silent** | test-credentials-detect.mjs |
| T14 | SKILL.md: `/^description:\s*(.+)$/m`, `/^\*\*Version:\*\*\s*(.+)$/m` or `/^version:\s*(.+)$/m` | `app/api/skills/route.js:117-127` | Skills page (bundled + workspace skills) | Blank description (**silent**) | none |
| T15 | Banner-tolerant JSON extraction (first `{`/`[` to last `}`/`]`, or first line starting with `{`) | `daemon.js:927,1260`; `lib/agent-devices.ts:84-93`; `lib/agent-update.ts:123-124`; `lib/subscriptions-parse.js:56-67`; `lib/credentials/mongodb.ts:69-80`; `lib/agent-plugins.ts:106-121` — vs strict whole-output parse at `lib/openclaw-cron.ts:175,321`, `lib/channelManager.ts:426` | All CLI JSON reads | Strict ones break on any banner line | partial |

## 12. Version-dependent logic

| ID | Logic | Call sites | Rev4a feature | Failure mode if changed | Test | Verified-on note |
|---|---|---|---|---|---|---|
| V1 | Supported list + `localRepository`/`registryRepository` | `lib/agent-versions.json`; `lib/agent-versions.ts:38-56`; `bin/rev4a.js:44-45` | Download, update, rollback, image banner | New release unsupported until added | test-image-revisions.mjs | agent-versions.ts:5-7 "nothing detects versions at runtime" |
| V2 | `modelInput` per version; unknown version → intersection (`conservativeModelInput`) | `lib/agent-versions.ts:58-75`; `app/api/gateway/sync.ts:39-56,99-112` | Provider catalogue `input` | Removed modality → whole catalogue rejected (**silent** to Rev4a). Adding or removing an entry changes the intersection for every agent whose version cannot be read, at the next Sync All (B25) | none | — |
| V3 | `containerVersionSync`: image tag → `.last-version` (exec, then `docker cp`) | `app/api/gateway/sync.ts:60-89` | Per-agent modelInput | null → conservative list | none | — |
| V4 | Image label `org.opencontainers.image.version`, else version tag, else `openclaw --version` (cached per image id, unknown TTL 5 min) | `lib/agent-images.ts:28,57-64,87,124-178`; `lib/subscriptions.ts:224-238` | Agents list version, update candidate | — | test-image-revisions.mjs | — |
| V5 | `isSupportedLine` (major.minor match) for subscription support | `lib/subscriptions-parse.js:356-366`; `lib/subscriptions.ts:168-172,224-238` | Subscriptions 409 "not on a supported OpenClaw version (2026.10.x or 2026.9.x)" | — | test-subscriptions.mjs | — |
| V6 | Credentials floors: `NATIVE_MIN_VERSION='2026.9.0'`, `minVersion:'2026.9.9'` for trello, mongodb | `lib/credentials/native.ts:17-19,41-50,64-87,211-220,323-340`; hint in `app/api/assistant/route.ts:84` | Credential delivery | — | test-credentials-native.mjs | native.ts:44-49 "`jq` only entered the image with 2026.9.9" |
| V7 | Browser approval assumed for every version answering `/startupz` with a version | `lib/agent-devices.ts:100-120`; `app/agents/BrowserAccessSection.tsx:6` | Browser access panel | see H2 | none | "OpenClaw 9.x" |
| V8 | Update preflight: supported, downloaded, newer (`compareVersions`); rollback refused for a version no longer listed | `lib/agent-update.ts:231-247,446-452` | Update / Roll back | — | test-agent-update-resolution.mjs | — |
| V9 | Update finish: ready + `runningVersion === toVersion` (3 retries 5 s) | `lib/agent-update-resolution.ts:80-121,198-200` | Update verification | — | test-agent-update-resolution.mjs | — |
| V10 | `ARG OPENCLAW_VERSION=` parsed from the Dockerfile for local builds | `lib/buildAgentImage.ts:150-156,272`; `bin/rev4a.js:251,263` | Dev builds without registry | — | none | — |
| V11 | Entrypoint `--token` vs env decision for older images | `entrypoint.sh:107-133`; `rev4a-gateway-auth` | Token handling | — | test-gateway-auth-entrypoint.mjs | entrypoint.sh:113-114 (2026.9.3 / 384bd8e) |
| V12 | Node floor 24.22.1 at build | `Dockerfile:34-38` | Image build | — | none | "OpenClaw 2026.10.6 to 2026.10.9 refuse to start below it; 2026.10.10 starts but warns" |
| V13 | Context page bootstrap rules (files, order, caps 20000/60000, sub-agent AGENTS.md only, MEMORY.md exclusions) | `lib/memory-context.ts:16-56,214-220`; hint `app/api/assistant/route.ts:106-108` | Context page | Wrong numbers (**silent**) | test-memory-context.mjs | "verified on 9.3 and 9.9" / "(verified on 9.9)" |
| V14 | `rev4a serve` pulls `supported[0]` of `lib/agent-versions.json` (pinned `imageRevision` when set) **synchronously, before the dashboard starts**; on failure it builds the image locally when the Dockerfile's `ARG OPENCLAW_VERSION` is that version. After a successful update, retention keeps only the two newest local versions plus images a container uses | `bin/rev4a.js:208-271` (`ensureAgentImage`, pull timeout 30 min `:235`), `:533-551` (`preflight`); `lib/update-state.js:40,240-246` (dashboard update marked failed after 5 min); `lib/agent-images.ts:433-462` (`pruneAgentImages`), called at `lib/agent-update.ts:303-306` | First run after a Rev4a update that adds a version, rollback from the oldest supported version | A large TO image delays the dashboard by the whole pull (and a 15+ min local build if the registry fails); the dashboard's own update reports "did not restart within 5 minutes". A rollback to a pruned version pulls it again (fails offline) | none | — |
| V15 | A recreate keeps the agent's version; when that version's image is gone, it is pulled only if this Rev4a still lists the version | `lib/agent-images.ts:473-499` (`resolveRecreateImage`, refusal `:498`); `lib/agent-update.ts:446-450` (rollback refused for an unlisted FROM) | Recreate, edit, rollback after a Rev4a downgrade or after TO is withdrawn from `agent-versions.json` | An agent on a version this Rev4a does not list cannot be recreated once its image is pruned: "The image for OpenClaw <v> is not available locally" (loud) | none | — |

## 13. Image build steps

| ID | Step | Where | Why Rev4a needs it | Failure mode | Test |
|---|---|---|---|---|---|
| B-1 | `FROM node:24-bookworm-slim` | `Dockerfile:19` | Node for OpenClaw and every `node -e` script (`node:sqlite` needs Node ≥ 22.5) | — | none |
| B-2 | Node ≥ 24.22.1 guard | `Dockerfile:38` | OpenClaw 2026.10.x requirement | Build fails (loud) | none |
| B-3 | apt `curl` | `Dockerfile:47` | `/startupz` probes (`agent-readiness.ts:62`, `agent-devices.ts:102`, `agent-update.ts:143`) | Without curl every readiness wait fails → create deletes the agent | none |
| B-4 | apt `jq` | `Dockerfile:50` | Bundled trello skill | Trello skill not eligible | none |
| B-5 | apt `openssl`, `gh` | `Dockerfile:48,51-55` | Entrypoint random token; GitHub CLI | — | none |
| B-6 | `npm install -g openclaw@${OPENCLAW_VERSION} vercel --allow-scripts=openclaw` (+ Supabase CLI release) | `Dockerfile:69-74` | The runtime itself | — | none |
| B-7 | Seed config patches (gateway.mode, controlUi fallback, extraDirs, bootstrap hook) | `Dockerfile:75-88` | New volumes only | — | none |
| B-8 | duckduckgo plugin pinned to the same version | `Dockerfile:98-101` | Web search | Build fails if not published | none |
| B-9 | `rev4a-apt`, `rev4a-packages-restore`, `rev4a-gateway-auth`, entrypoint | `Dockerfile:111-127` | Durable apt, token mode | — | test-rev4a-apt.sh, test-gateway-auth-entrypoint.mjs |
| B-10 | `LABEL org.opencontainers.image.version`, `.revision` | `Dockerfile:31-32` | Version without exec (V4) | Missing label → slow `--version` exec path | test-image-revisions.mjs |
| B-11 | Implicit (not installed explicitly, from base image): `timeout`/`stat` (coreutils), `script` (util-linux/bsdutils), GNU `tar`, `sh`, `head`, `tr` | `lib/exec-timeout.js:40-62`; `lib/subscription-login.ts:57`; `lib/cold-backup.ts:64-82`; `lib/agent-token.ts:42-43` | Timeouts, device login TTY, cold backup, token mode repair | A slimmer base drops them (timeout has a fallback; `script` and tar do not) | test-docker-exec.mjs |
| B-12 | `EXPOSE 3000`, `WORKDIR /data`, `ENTRYPOINT`/`CMD` | `Dockerfile:129-133` | Port convention | — | none |

## 14. Behaviour assumptions

| ID | Assumption | Where relied on | Failure mode if false | Verified-on note |
|---|---|---|---|---|
| B1 | `config patch` is a deep merge: objects merged, **arrays replaced**, `null` deletes a key | `lib/agent-setup.ts:143-166`; `lib/credentials/native.ts:176-181,269-310`; `lib/subscriptions.ts:523-546`; `Dockerfile:81-83` | Fallback lists merged/duplicated; keys not removed (subscriptions re-reads: loud; others **silent**) | — |
| B2 | Gateway watches `openclaw.json` and hot-applies `models`, `agents`, `gateway.controlUi`, `channels` with `gateway.reload` default `hybrid`; no restart needed | `app/api/gateway/sync.ts:312-317,496-505`; `app/api/gateway/agent/route.ts:202-209`; `app/api/agents/create/route.ts:418-420,433-434`; `lib/channelManager.ts` (no restart after write) | Changes not applied until restart (**silent**) | gateway/agent route.ts:203-206 "Confirmed against a live agent"; sync.ts:500-502 "Verified against a live agent" |
| B3 | `openclaw gateway restart` does nothing in a container (no systemd) | `app/api/agents/create/route.ts:418-420` | — | — |
| B4 | Rotating the token = rewrite `/root/.agent-token` + `docker restart`; gateway reads the token only at start; config `gateway.auth` beats env but not `--token` | `app/api/agents/token/route.ts:104-108`; `lib/agent-token.ts:3-8`; `entrypoint.sh:107-118`; `rev4a-gateway-auth:7-9` | Old token keeps working / new refused. A **fleet action** (FL4): one PUT rewrites the token and restarts every running agent (`app/api/agents/token/route.ts:76-108`) | — |
| B5 | `doctor --fix --non-interactive` migrates the schema with the gateway stopped and never restarts it; the gateway refuses an old schema rather than migrating; the previous version refuses a migrated DB (rollback = restore backup) | `entrypoint.sh:23-44`; `lib/agent-update.ts:16-19`; `lib/agent-readiness.ts:11-15` | Updates hang or corrupt; rollback path wrong | entrypoint.sh:27 "From 2026.9.x" |
| B6 | A gateway refusing readiness still answers 200 on `/health`; `/readyz` fails on channel token problems | `lib/agent-readiness.ts:4-23` | — (why `/startupz` is used) | — |
| B7 | `usage.cost`/`sessions.usage` answer zeros with `cacheStatus` ≠ `fresh` while an index rebuilds (~60 s after price change or restart); first call starts the rebuild | `daemon.js:836-843,1142-1148` | Never fresh → stale costs with error; or zeros stored | daemon.js:840 "Measured on a VPS (2026-09-27)" |
| B8 | `gateway call --json` prints its error as JSON on stdout and exits 1, stderr often empty | `daemon.js:859-864` | Less readable errors | — |
| B9 | An agent with nothing in the range answers without `cacheStatus` | `daemon.js:978-985` | — | — |
| B10 | OpenClaw prices each call from `models.providers.*.models[].cost`, keeps the cost recorded at call time; all-zero cost = "no price"; no cost → `missingCostEntries` | `app/api/gateway/sync.ts:94-100`; `lib/model-pricing.ts:131-150`; `lib/price-schedule-sync.ts:4`; `lib/agent-costs.ts:33,92-95` | Costs wrong / free models flagged | — |
| B11 | Days are UTC dates as OpenClaw buckets them | `daemon.js:701-702`; `lib/agent-costs.ts:8` | Off-by-one-day spend | — |
| B12 | `docker exec` may exit 0 / return partial output when killed at its deadline | `lib/agent-readiness.ts:46-55`; `lib/agent-devices.ts:79-83`; `lib/channelManager.ts:315-317`; `app/api/agents/[id]/model/route.ts:73-77`; `lib/credentials/detect.ts:183-195` | (Docker behaviour, guarded with sentinels) | detect.ts comment: "verified directly against a real container" |
| B13 | OpenClaw drops `GH_TOKEN`, `GITHUB_TOKEN`, `MONGODB_URI`, `DATABASE_URL`, `REDIS_URL`, `AMQP_URL` from exec env (`blockedOverrideOnlyKeys`) | `lib/credentials/managed.ts:6-13`; `lib/credentials/native.ts:52-80` | Credential names chosen around it | — |
| B14 | GitHub managed identity: handoff name must be `github-setup-<32 lowercase hex>`; consumed only by a successful configure; OpenClaw validates the PAT and writes its own gh profile | `lib/credentials/managed.ts:6-13,36,54-56,143-148` | Enable fails / handoff leaks | — |
| B15 | Retired GitHub profiles linger until the Gateway restarts (hence read by `profileId`) | `lib/credentials/detect.ts:137-139` | — | — |
| B16 | On the ChatGPT (Codex) runtime, secret-store env entries reach only commands run through OpenClaw (`gateway_exec`) | `lib/credentials/native.ts:378-379`; `lib/credentials/runtime.ts:11-16`; `rev4a-rules/AGENTS.md:34-38` | Wrong advice to agents/users | — |
| B17 | Codex app-server keeps running after sign-out; killing it is safe and restarts on next turn | `lib/subscriptions-parse.js:312-318`; `lib/subscriptions.ts:593-597` | — | "Verified on OpenClaw 2026.9.3 (2026-10-09)" |
| B18 | `models auth login --device-code` needs a TTY; the CLI keeps writing config for a moment after "complete" | `lib/subscription-login.ts:4-6,86-104` | Login hangs / config write race | — |
| B19 | Subscription provider ids are `openai` (native ChatGPT route) and legacy `openai-codex`; subscription models are `openai/<id>` | `lib/agent-costs.ts:67-76`; `lib/subscriptions-parse.js:7,155` | Subscription calls counted as spend | — |
| B20 | One OpenClaw agent per container with id `main`; bindings to `main` give sessions `agent:main:main`; model bindings target `agent:main:*` | `lib/credentials/managed.ts:33-34`; `lib/channelManager.ts:233-246`; `lib/agent-sessions.js:75,119-121` | Sessions/models of other ids ignored | — |
| B21 | First boot generates `openclaw.json` before `/startupz` is ready (create reads it right after) | `app/api/agents/create/route.ts:368-374` | Create config silently skipped (`catch {}` at :421-423) | — |
| B22 | OpenClaw never auto-selects duckduckgo; a provider is refused at validation unless its plugin is discoverable (paths first) | `entrypoint.sh:59-62,96-97` | Web search off | — |
| B23 | `secrets store rm` without `--yes` prompts, removes nothing, exits 0; `rm` of a missing name exits 0 | `lib/credentials/native.ts:102-106,360-362` | Disable reports success with secret left | — |
| B24 | The OpenClaw CLI is slow (boots a Node process + plugins: 2.5-12 s, ~200-360 MB); sizing of concurrency/timeouts | `lib/docker-exec.ts:9-11`; `lib/openclaw-cron.ts:49-58`; `daemon.js:1177`; `lib/subscriptions.ts:8,184`; `lib/exec-timeout.js:7`; `lib/subscription-usage.ts:7-8` | Timeouts if a release is slower | measured, no version named |
| B25 | **Sync All rewrites `openclaw.json` of every agent container, running AND stopped**, with no user action: read whole file, replace `models.providers.rev4a`, write whole file back (`docker exec … cat >` when running, `docker cp` when stopped); on running agents it first deletes P8. Busy agents (update, recreate, restore, edit, cold backup) are skipped | `app/api/gateway/sync.ts:151-168` (`docker ps -a`), `:375-462` (`syncAllAgents`), `:467-508` (`syncContainer`), `:198-253` (read/write, running or stopped); triggers FL1-FL3 (`instrumentation.ts:25`; `lib/price-schedule-sync.ts:72`; `app/api/gateway/provider/route.ts:224-227,241,256,297`) | Relies on B2 (hot reload) and on the file being the source of truth. A release that rejects or stops watching a whole-file write leaves every agent's catalogue stale; one that keeps live state in a P8 file loses it at each Rev4a start (**silent**, every install). Stopping an agent does not keep it out of a sync: its file is still rewritten | `app/api/gateway/sync.ts:496-502` (reload, live agent) |
| B26 | OpenClaw sends `models.providers.rev4a.apiKey` as the Bearer credential: a derived agent token authenticates its own id; `headers` (`x-rev4a-agent`) remains for legacy shared-key callers and older readers | `app/api/gateway/sync.ts:278-288`; `lib/proxy-usage.js:15-19`; `app/api/provider/v1/chat/completions/route.ts:96-101` | Token dropped/changed → authentication fails; ids outside the historical `agent_cost_sources` known set meter as `unknown` (cached 60 s); retained deleted ids still receive attribution exactly like legacy headers. Deletion removes the container holding the token, without revoking a copy; header ignored for token calls. A dropped header affects only legacy shared-key metering. Root rotation invalidates all derived tokens; sync rewrites both running and stopped agents. `v1.24.0` rollback startup sync restores shared keys (skips/failures need later sync/patch). | test-agent-proxy-token.mjs |
| B27 | Restore has **no version check**: any archive of the agent is extracted onto the container's current image; no readiness wait, no Rev4a config re-apply (credentials only) | `lib/agent-restore.ts:54-96` (extract `:67-77`, credentials `:91`) | With B5: a backup taken on TO, restored after a rollback to FROM, gives a Gateway that refuses its database. The row can say `done` while that Gateway crash-loops: `startAndVerifyContainer` checks only running/network (`lib/agent-recreate.ts:68-79`). A FROM-era backup on TO depends on `.last-version` (P3) triggering Doctor; verify `/startupz` separately | — |
| B28 | OpenClaw derives its other ports (browser, canvas) from the gateway port 3000; Rev4a publishes one 10-port block `3000-3009` | `lib/agent-ports.ts:7-16` | A derived port outside the block is unreachable from outside the container (**silent**) | agent-ports.ts:9 (comment, no version) |
| B29 | OpenClaw never writes into `/root/.openclaw/workspace/.rev4a` (P11, read-only mount) | `lib/agent-setup.ts:38-42` | A release that writes, cleans or `git init`s the whole workspace fails on that subdirectory | — |
| B30 | Rollback restores the pre-update volume and recreates on FROM **without re-applying Rev4a's config** (credentials only), and extracts with an unpinned `alpine` image from Docker Hub | `lib/agent-update.ts:468-512` (no re-apply `:468-472`; `alpine` `:494-504`); the same `alpine` extract in `lib/agent-restore.ts:67-77` | After days on TO, the restored `openclaw.json` can disagree with Rev4a. Sync All repairs the provider catalogue only (`app/api/gateway/sync.ts:488-494`), never the primary model under `agents.*`; an offline or rate-limited host fails mid-rollback | — |
| B31 | Update stores legacy cron names plus rich stable identity/ownership. Exact evaluated retirements are separated from user loss; historical name-only failures require a conservative archive ownership audit | `lib/agent-update-cron.ts`; `lib/agent-update-state.ts`; `lib/backup-cron-evidence.ts`; `lib/agent-update.ts` | Partial/malformed inventories fail before backup/agent mutation. An unresolved archive audit cannot silently clear a failure; preserve original failure, baseline, verification and times | test-agent-update-cron.mjs, test-backup-cron-evidence.mjs |
| B32 | Rebuild carries the cap; Create/Update apply target-specific finite floor and bounded Docker API host admission before lifecycle mutation | `lib/agent-resource-policy.js`; `lib/agent-resource-preflight.ts`; `lib/agent-update.ts:226`; `app/api/agents/create/route.ts` | Exact10.10 floor4096 MiB;9.3/9.9 cap choice remains. Unlimited stays unlimited, with planning reserve. Unknown/headroom failures are explicit; no automatic cap increase | test-agent-resource-policy.mjs |
| B33 | Stored-account cron execution may require explicit `model@profile` adoption after migration; model Default and configured/per-job fallbacks remain separate from account authority | `lib/control-ui-navigation.ts`; `app/crons/PageClient.tsx`; `app/subscriptions/PageClient.tsx`; J5/J6 and S1 | Only the newest loaded exact missing-account failure shows the guide. Per-agent references are read-only; account is never guessed. Native Pause→Custom model Save→Default Save keeps binding; delivery Account ID is separate | test-control-ui-navigation.mjs, test-subscription-profile-references.mjs; bounded native browser/live run |
| B34 | Native `/automations?job=<id>` and Settings model picker support the guided adoption path | `lib/control-ui-navigation.ts:9`; `app/api/agents/[id]/open-control-ui/route.ts`; `app/agents/BrowserAccessSection.tsx` | Job IDs are validated before link issuance; root/auth fragment unchanged. Native route/controls may drift across releases; verify deep-link, successful CAS saves, binding and no model override live | test-control-ui-navigation.mjs; bounded browser proof |

---

## A. OpenClaw-owned cron jobs / built-in things Rev4a compares or counts

| What | Where | How it is used | Risk on a new release |
|---|---|---|---|
| All cron jobs (user and any OpenClaw built-in), by `name ?? id` | `lib/agent-update.ts:121-130,163-175,188-205` | Baseline before update vs after: any name missing fails the update | A built-in job renamed/removed → every update fails "cron jobs missing" |
| Count of enabled cron jobs (`enabled !== false`) | `app/api/system-health/route.ts:212-229` | "No enabled cron detected" recommendation (named "watchdog") | Built-in jobs added → recommendation never shows |
| Transcript events per session, every agent dir and session incl. internal ones (heartbeat, cron runs) | `lib/agent-update.ts:69-111` | Must not decrease across an update | Release that compacts/prunes transcripts during `doctor --fix` → false "lost events" |
| Sessions of agent id `main` only; kinds incl. `dashboard`, `explicit` | `lib/agent-sessions.js:75,97-106` | Sessions graph | New built-in kind → `direct` |
| Cron root rows `agent:main:cron:<jobId>` excluded from events | `lib/agent-sessions.js:304-306` | Event dedupe | Key format change → double events |
| Cost rows with no tokens and no cost ("OpenClaw also counts internal entries") | `lib/agent-costs.ts:33-35`; `daemon.js:1022` | Filtered out | — |
| `missingCostEntries`, `totals.missingCostByModel` | `daemon.js:1028,1045,1051`; `lib/agent-costs.ts:53` | "calls without a price" warning | Rename → warning silently gone |
| Bundled skills dir listing (`github`, `trello`, `notion` assumed bundled) | `app/api/skills/route.js:178-196`; `lib/credentials/native.ts:52-87` | Skills page; credential skill names | Bundled skill renamed → credential skill entry ignored (**silent**, except MongoDB) |
| Built-in hook `bootstrap-extra-files` | `lib/agent-setup.ts:87-98` | Rev4a rules injection | Hook renamed → rules gone (**silent**) |
| Bootstrap file set and order (AGENTS, SOUL, IDENTITY, USER, BOOTSTRAP, MEMORY; TOOLS/HEARTBEAT not injected) | `lib/memory-context.ts:42-56` | Context page | Wrong page |
| Heartbeat default `0m` (Rev4a turns OpenClaw's built-in heartbeat off unless set) | `entrypoint.sh:51-52,80` | Cost control | Key rename → heartbeat back on (cost) |
| Template bootstrap files: `HEARTBEAT.md` (atlas), `BOOTSTRAP.md` (custom), plus `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `TOOLS.md`, `MEMORY.md` per template | `agent-templates/*/`; copied by `app/api/agents/create/route.ts:336-362` | Rely on OpenClaw's bootstrap injection and its first-run (`BOOTSTRAP.md`) handling | A release that ignores, renames or deletes one changes every new agent made from that template (**silent**) |

## B. Fixed timeouts that assume OpenClaw speed

| Value | file:line | What it bounds |
|---|---|---|
| 15 s default | `lib/docker-exec.ts:27` | Any `dockerExec` without a value (pairing list/approve, cron list per port) |
| 60 s (`--timeout 55000`) | `daemon.js:844,925` | Each `gateway call` (usage.cost, sessions.usage, sessions.list) and `cron runs` |
| 6 × 20 s | `daemon.js:842-843` | Waiting for a fresh usage index (~60 s rebuild) |
| 5 min / first 20 s | `daemon.js:829-831` | Costs collection interval |
| 10 s tick / 15 s first / 5 min cron-runs cadence | `daemon.js:1182-1185,1302` | Sessions collection |
| 5 s | `daemon.js:1567` | `cat packages-status.json` (Rev4a file) |
| 15 s per port × 2 | `lib/openclaw-cron.ts:200` | `cron list` (Crons page, system-health) |
| 10 s | `lib/openclaw-cron.ts:221,367` | `cron enable/disable/remove` |
| 15 s | `lib/openclaw-cron.ts:319` | `cron runs` (UI) |
| 8 s | `lib/openclaw-cron.ts:41`; `lib/docker-exec.ts:146` | `timeout` wrapper probe |
| 120 s | `lib/agent-update.ts:114,122` | Transcript count, `cron list` for update |
| 10 s (curl 3 s) | `lib/agent-update.ts:143` | `/startupz` version read |
| 60 s | `lib/agent-update.ts:509` | `openclaw --version` after rollback |
| 10 min | `lib/agent-update.ts:53` | Migration readiness first window |
| +30 min extra, 30 s checks, 5 s × 3 version retries | `lib/agent-update-resolution.ts:58-65` | Update slow-start window |
| 3 restarts | `lib/agent-update-resolution.ts:44-45` | Crash-loop detection |
| 5 min | `lib/agent-update.ts:390` | Rollback readiness |
| 60 min | `lib/agent-update.ts:389` | Restore |
| 30 min | `lib/agent-update.ts:54`; `lib/agent-recreate.ts:34` | Cold backup wait |
| 5 min | `lib/agent-update-resolution.ts:249` | Resolution re-check |
| 30 s | `lib/agent-images.ts:175` | `openclaw --version` for unlabelled images |
| 5 min | `lib/agent-images.ts:150` | Unknown-version cache |
| 120 s default, 2 s poll, 5 s attempt | `lib/agent-readiness.ts:36,39,126` | `waitForGatewayReady` |
| 120 s native / 300 s emulated | `lib/agent-volumes.ts:12,15` | Create readiness (failure deletes the container) |
| 480 s maxDuration | `app/api/agents/create/route.ts:32` | Create request |
| 8 s / 15 s | `app/api/agents/create/route.ts:373,414` | Read/write openclaw.json at create |
| 5 min | `lib/agent-recreate.ts:31` | Recreate readiness |
| 120 s | `lib/agent-recreate.ts:173,184` | `docker run` |
| 5 min | `lib/agent-edit.ts:21` | Edit readiness |
| 10 min | `lib/credentials/delivery.ts:633` | Credential re-apply readiness |
| 30 s default / 150 s reload | `lib/credentials/native.ts:110-112,301-320`; `lib/credentials/delivery.ts:314-319` | Native/managed steps default to 30 s; config patch and secrets reload request 150 s (enable, disable, MongoDB rollback, consistency pass) |
| 5 s | `lib/credentials/native.ts:114-115,307` | Direct config-file read after a patch timeout; patched keys must match, null means absent |
| 25 s | `lib/credentials/detect.ts:271-272` | Credential probe (incl. node DIGEST_SCRIPT) |
| 60 s | `lib/credentials/mongodb.ts:31` | `skills info` ("took 7 s on a Mac") |
| 5 min ceiling | `lib/credentials/mongodb.ts:29,128-132` | mongosh install |
| 10 min | `lib/gateway-state.ts:24` | "Not ready" after start on Agents page |
| 3 s / 60 s ready TTL / 2 s not-ready TTL | `lib/gateway-status.ts:26-30` | Agents page probe |
| 3 s | `app/api/agents/[id]/open-control-ui/route.ts:64` | Open probe |
| 20 s / 30 s / 8 s | `lib/agent-devices.ts:20-22` | devices CLI / dashboard link / startupz+token read |
| 60 s, 16 MB buffer, 60 s cache | `lib/agent-plugins.ts:11,14,178` | `plugins list` |
| 20 s | `lib/channelManager.ts:387` | Pairing-store node script |
| 15 s / 3 s | `lib/channelManager.ts:47,77,92` | openclaw.json read/write, `docker ps` |
| 15 s | `lib/agent-setup.ts:109` | Each guaranteed `config patch` |
| 15 s | `app/api/gateway/sync.ts:330` | Provider `config patch` |
| 8 s / 10 s / 5 s | `app/api/gateway/sync.ts:202-207,237-248,68-84,480-482` | Sync All read/write/version/cleanup |
| 25 s | `lib/subscriptions.ts:53` | `models list` |
| 12 s, retries 1 s + 2 s | `lib/subscriptions.ts:205,207` | STATUS_SCRIPT |
| 5 s | `lib/subscriptions.ts:211` | Version check via Docker API |
| 30 s | `lib/subscriptions.ts:308,539` | Subscription `config patch` |
| 60 s (+10 host) | `lib/subscriptions.ts:77,655` | `models.authLogout` Gateway call |
| 10 s | `lib/subscriptions.ts:596` | STOP_CODEX_SCRIPT |
| 900 s / 60 s ready / 60 s tail | `lib/subscription-login.ts:51-52`; `lib/subscriptions-parse.js:252-255` | Device login |
| 120 s in-container / 130 s host / 3 min cache | `lib/subscription-usage.ts:19-21` | `status --usage` |
| 8 s / 5 s | `app/api/agents/[id]/model/route.ts:72`; `app/api/agents/models-summary/route.ts:115`; `lib/credentials/runtime.ts:20`; `app/api/agents/config-json/route.ts:30` | openclaw.json reads |
| 20 s | `app/api/agents/token/route.ts:108` | Restart after token rotation |
| 30 s | `app/api/agents/[id]/restart/route.ts:32` | `docker restart` |
| 60 s maxDuration | `app/api/crons/runs/route.ts:9` | Cron runs route |

## C. Memory-limit defaults and recommendations

| Value | file:line | Note |
|---|---|---|
| Version-specific advice and admission | `lib/agent-resource-policy.js:9-28`; `app/components/ui/MemoryLimitPicker.tsx` |9.3/9.9 retain2 GiB warning; exact10.10 finite Create/Update floor4096 MiB. Existing cap edits remain explicit. Unknown release advice is not admission authorization |
| Presets 1536, 2048, 3072, 4096, 6144, 8192, 12288, 16384 MB | `lib/agent-memory-limit.js:43-44` | Wizard / RESOURCES picker |
| Minimum 256 MB, max 1 TiB | `lib/agent-memory-limit.js:12-13` | Validation only |
| Default for new agents: none unless set in `agent-defaults.json` | `lib/agent-defaults.ts:17-36` | No OpenClaw-based default |
| `--memory` = `--memory-swap` (no swap) | `lib/agent-create-args.ts:25` | OOM risk if OpenClaw grows |
| Existing agents keep caps through rebuilds; Update checks them before backup/stop | `lib/agent-recreate.ts`; `lib/agent-update.ts:226`; `lib/agent-resource-preflight.ts` | Target policy protects existing installs too; insufficient caps fail clearly without being changed |
| Boot peak: `doctor --fix` runs first (version change only), then the Gateway starts while `rev4a-packages-restore` reinstalls apt packages in the background | `entrypoint.sh:35-44,98-105` | Startup memory on the first boot after an update is higher than on a plain restart |
| Update baseline: `COUNT_TRANSCRIPTS` reads every transcript `.jsonl` whole into memory with `node -e`, inside the agent container next to the running Gateway | `lib/agent-update.ts:72-118` (`readFileSync` `:77`) | On a large agent it can time out (120 s) or push the container over its limit before the update starts |
| Every OpenClaw CLI call Rev4a makes runs inside the agent container, under its limit (one Node process plus plugins each, B24); Rev4a's own fan-outs (section G) add several at once | `lib/docker-exec.ts`; `lib/exec-timeout.js:7` | A Gateway near its limit is killed by a Rev4a read, not by its own work |
| `container_oom` alert from Docker's `oom` event stream: the only signal a user sees when a process in an agent is killed for memory (a Gateway killed inside the container leaves `OOMKilled: false`) | `daemon.js:519,532-645` (`recordAnomaly(…'container_oom'…)` `:556`, event filter `:607`) | Check that it fires whenever an evaluation reproduces an OOM |

Related sizes: `openclaw devices list` "~200 MB of Node" (`lib/exec-timeout.js:7`), `status --usage` "about 360 MB" (`lib/subscription-usage.ts:7-8`), `compaction.maxActiveTranscriptBytes='20mb'` (`entrypoint.sh:53-55,81`).

## D. Places that parse OpenClaw human-readable text instead of JSON

| What | file:line |
|---|---|
| `openclaw --version` text (+ entrypoint string compare with `.last-version`) | `lib/agent-versions.ts:77-84`; `lib/credentials/native.ts:338-340`; `entrypoint.sh:35-37` |
| Device-code login output (URL, code, expiry, complete/failed/timed out) | `lib/subscriptions-parse.js:9-53` |
| `openclaw pairing approve` output (`includes('error')`) | `lib/channelManager.ts:458-466` |
| `openclaw secrets store list` output (grep handoff names) | `lib/credentials/managed.ts:156-162` |
| CLI error text classification for plugins (`unknown command`, …) | `lib/agent-plugins.ts:163-174` |
| `gateway call` failure: last stderr line | `daemon.js:877-879` |
| SQLite error message `/no such table/i`, `/locked|busy/i` | `lib/subscriptions-parse.js:196,206` |
| `hosts.yml` written by OpenClaw's GitHub identity (`oauth_token:`, `user:`) | `lib/credentials/detect.ts:148,153` |
| SKILL.md front matter (`description:`, `version:` / `**Version:**`) of bundled skills | `app/api/skills/route.js:117-127` |
| Archive file names `archive-tier.<id>.jsonl.imported-<ts>`; `.jsonl` line counts as event counts | `lib/agent-update.ts:75-95` |
| Process cmdlines in `/proc/*/cmdline` (Codex app-server, login) | `lib/subscriptions-parse.js:319-322`; `lib/subscription-login.ts:64-66` |
| `config patch` CLI text "Change will apply without restarting the gateway" and `[reload] …` log lines (cited in comments as evidence, not matched in code) | `app/api/gateway/sync.ts:314-317`; `app/api/gateway/agent/route.ts:203-206` |

## E. Pages that display OpenClaw-derived data (indirect consumers)

Agents page and panel (`app/agents/PageClient.tsx:148,1280,1346-1394`, `UpdateSection.tsx`, `ImageDownloadBanner.tsx`, `BrowserAccessSection.tsx`, `ModelSection.tsx`, `CostSection.tsx`, `ChannelManager.tsx`, `SubscriptionLine.tsx`); Crons (`app/crons/PageClient.tsx`); Costs (`app/costs/PageClient.tsx`, `/api/costs*`, `/api/stream` today's spend); Sessions (`lib/types/index.ts`, `lib/patterns/sessionPresentation.ts:109-130`); Context (`app/memory/MemoryContextPageClient.tsx`); Plugins (`app/plugins/PageClient.tsx`); Subscriptions (`app/subscriptions/PageClient.tsx`, `UsageBlock.tsx`); Credentials (`app/credentials/PageClient.tsx`); Workspace (`app/workspace/*`); Skills; System cockpit (`app/components/SystemCockpit.tsx:126,213`); PULSE assistant hints describing OpenClaw behaviour (`app/api/assistant/route.ts:30,48,58,84,106-108,118`).

## F. Docs that describe these touchpoints

`docs/ARCHITECTURE.md` (pairing store, sessions.list, usage.cost, /startupz, config_machine_state, secret_store_entries, devices, cron list, doctor --fix, config patch, tools.github.configure, skills info, status --usage, device-code, .last-version, bootstrap-extra-files, dashboard --json); `docs/dev/API-REFERENCE.md` (pairing store, /startupz, transcript_events, secret_store_entries, devices, plugins list, cron list, doctor, config patch, status --usage, bootstrapMaxChars, auth-profiles.json, dashboard --json); `docs/dev/GATEWAY.md` (doctor --fix, config patch, auth-profiles.json, .last-version); `docs/dev/DATABASE.md` (sessions.list, usage.cost tables); `docs/REV4A.md`; `docs/rag/REV4A-OVERVIEW.md`; `docs/dev/SESSION-MAINTENANCE-PLAN.md`. `modelInput` is described in no doc (only in `lib/agent-versions.ts:9-11`).

## G. Fleet actions: Rev4a code that reaches every agent

What a Rev4a instance does to **all** agents of its Docker host, not to one agent picked by a person.
An evaluation instance started from a branch runs the automatic ones on the owner's agents too (it
sees every container labelled `AGENT_ID`). "Writes" rows change agent state; "Reads" rows start a
process inside every agent (memory, B24). "Running" = `docker ps`; "all" = `docker ps -a`, stopped
agents included.

| ID | Action | Trigger | Reaches | What it does in each agent | file:line |
|---|---|---|---|---|---|
| FL1 | Startup Sync All | **Automatic**: every Rev4a start (Next.js instrumentation) | **All** (running and stopped), except agents busy with an update, recreate, restore, edit or cold backup | Writes: B25 — whole-file rewrite of `openclaw.json` with the `rev4a` provider for that agent's version (`modelInput`, V2); `rm -f` of P8 on running agents | `instrumentation.ts:19-35`; `app/api/gateway/sync.ts:375-462,467-508` |
| FL2 | Price-band re-sync | **Automatic**: a check every minute; syncs at each band change (DeepSeek off-peak) when a time-priced model is offered, with up to 3 total timer-driven attempts (initial attempt plus 2 retries), 5 min apart when an agent was missed | Same as FL1 | Writes: same as FL1 | `instrumentation.ts:44-49`; `lib/price-schedule-sync.ts:29-34,68-121,128-133` |
| FL3 | Gateway page: save a provider key, toggle a model, Sync All Agents button (`_syncOnly`) | User, on the Gateway page | Same as FL1 | Writes: same as FL1 | `app/api/gateway/provider/route.ts:224-227,241,256,297` |
| FL4 | Agent token rotation | User (token PUT) | **Running** agents, except busy ones | Writes `/root/.agent-token`, then `docker restart` (B4) | `app/api/agents/token/route.ts:40-130` (loop `:96-108`) |
| FL5 | Token file mode repair | **Automatic** at every start | Running | `chmod go-rwx /root/.agent-token` when group/other bits are set | `instrumentation.ts:114-132`; `lib/agent-token.ts:35-69` |
| FL6 | Failed-update resolution | **Automatic** at every start (one agent at a time), and again on panel open (5-min recheck) | Agents whose latest update is `failed`/`interrupted` and unresolved | Reads `/startupz`, counts transcripts, lists cron jobs (B31); when proved fine, writes `applyRuntimeConfig` + `patchRev4aProvider` | `instrumentation.ts:60-64`; `lib/agent-update.ts:532-619`; `lib/agent-update-resolution.ts:249-253` |
| FL7 | Interrupted operations | **Automatic** at every start | Agents whose update, recreate, restore or edit was cut by the restart | Marks interrupted rows and starts containers; an interrupted restore with an available backup is **run again**, stopping the container, clearing the volume and extracting the archive | `instrumentation.ts:50-90`; `lib/agent-restore.ts:59-86,133-142` |
| FL8 | Cold-backup reconcile | **Automatic** at every start | Agents with a backup helper left over | Finishes exited helpers, starts the agent again if it was running | `instrumentation.ts:91-98`; `lib/cold-backup.ts` (`reconcileColdBackups`) |
| FL9 | Rev4a rules and shared skills | **Automatic** at `rev4a serve` | **All** agents, through the read-only mounts (P11, P12) | Copies `rev4a-rules/AGENTS.md` and `rev4a-skills/rev4a-*` into the data dir mounted into every agent: a changed rule or skill reaches every agent's next session. Only when the instance shares the data dir | `bin/rev4a.js:293-388` (called at `:545-546`); `lib/agent-setup.ts:33-42` |
| FL10 | Credential re-delivery after a secret is changed | User (credential PATCH) | Every agent holding that credential, two at a time | Writes: secret store set, skill entry patch, `secrets reload` (C20, C23, KW11) | `app/api/credentials/[id]/route.ts:10-15,31-60` |
| FL11 | Costs collector | **Automatic**, daemon, every 5 min (first after 20 s) | Running | Reads: one `usage.cost` "wake" call per agent, then `usage.cost` + `sessions.usage` per agent, one at a time (R1, R2) | `daemon.js:830-831,1125-1162,998-1052` |
| FL12 | Sessions collector | **Automatic**, daemon, 10 s tick (first after 15 s), per-agent back-off | Running | Reads: `sessions.list` up to 10 pages (R3); `cron runs` per job every 5 min (C4) | `daemon.js:1182-1184,1270-1309,1353-1437` |
| FL13 | Packages status | **Automatic**, daemon, every 10 min (first after 60 s) | Running | Reads `/root/.rev4a/packages-status.json` (no OpenClaw process) | `daemon.js:1564-1629` |
| FL14 | Container metrics, OOM stream | **Automatic**, daemon | All containers (Docker API) | No exec: `docker stats`/events only | `daemon.js:443-645` |
| FL15 | Home page system health | User opens Home | Running | Reads: `cron list` in every agent (up to two ports each, C2) | `app/components/DashboardLayout.tsx:60`; `app/components/SystemCockpit.tsx:126`; `app/api/system-health/route.ts:212-229`; `lib/openclaw-cron.ts:230-260` |
| FL16 | Crons page | User opens Crons | Running | Reads: `cron list` in every agent (C2) | `app/crons/PageClient.tsx:207`; `app/api/crons/route.ts:10-29` |
| FL17 | Agents page | User opens Agents; polls every 3 s while an agent starts, else 30 s | Running (gateway: all) | Reads: `/startupz` (H1) every poll; `devices list` + `/startupz` (C10); `cat openclaw.json` for channels and models (KR1-KR4) | `app/agents/PageClient.tsx:369,385,462,487,517`; `lib/gateway-status.ts:68-126`; `app/api/agents/devices-summary/route.ts:17-36`; `app/api/agents/channels-summary/route.ts:31-64`; `app/api/agents/models-summary/route.ts:64-120` |
| FL18 | Credentials page | User opens Credentials | All listed agents | Reads: detection probe (S2, `DIGEST_SCRIPT`) and Codex runtime check per agent | `app/credentials/PageClient.tsx:285`; `app/api/credentials/detect/route.ts:153-180` |
| FL19 | Skills page | User opens Skills | Running | Reads: shell loop over `workspace/skills` in every agent; bundled dir from the first that answers (P13) | `app/skills/PageClient.tsx:92`; `app/api/skills/route.js:130-199` |
| FL20 | Subscriptions usage and models | User opens Subscriptions, or an agent card with a ChatGPT model (60 s poll) | Running (discovery), then one agent per account | Reads: `STATUS_SCRIPT` (S1) in every running agent to find the accounts; `status --usage` (C19) and `models list` (C16) in one agent per account | `lib/subscriptions.ts:433-450`; `lib/subscription-usage.ts:84-100`; `app/agents/SubscriptionLine.tsx:82-91` |

Not fleet actions, for contrast: Update, Roll back, Recreate, Edit, Restore, memory limit, Telegram,
model panel, Browser access, Plugins (one agent picked on the page), Crons toggle/delete — each takes
one agent id.

## H. Code that runs without a user action

Everything that runs on its own after an install, an update of Rev4a, a reboot, or an agent start.
FL rows are the same actions as in section G.

| ID | When | What | OpenClaw touchpoints | file:line |
|---|---|---|---|---|
| AU1 | `rev4a serve`, before the dashboard | Pull (or build) the image of `supported[0]` | V14 | `bin/rev4a.js:208-271,533-551` |
| AU2 | `rev4a serve` | Copy Rev4a rules and shared skills into the data dir (FL9) | KW1, KW2, P11, P12 | `bin/rev4a.js:293-388` |
| AU3 | Rev4a start | Tighten the credential vault file mode | none | `instrumentation.ts:11-18` |
| AU4 | Rev4a start | Startup Sync All (FL1) | KW8, KW13, P8, B2, B25 | `instrumentation.ts:19-35` |
| AU5 | Rev4a start, then every minute | Price-band re-sync (FL2) | same as AU4 | `instrumentation.ts:44-49` |
| AU6 | Rev4a start | Interrupted update/recreate/restore/edit recovery (FL7); an interrupted restore can clear and re-extract the agent volume automatically | H1 (later starts), P1, P17 | `instrumentation.ts:50-90`; `lib/agent-restore.ts:59-86,133-142` |
| AU7 | Rev4a start (not awaited) | Failed-update resolution (FL6) | H1, H2, S3, P5-P7, C2, KW1-KW3, KW8 | `instrumentation.ts:60-64` |
| AU8 | Rev4a start | Cold-backup reconcile (FL8) | P17 | `instrumentation.ts:91-98` |
| AU9 | Rev4a start (not awaited) | Backups migration out of the legacy `rev4a-backups` volume | none | `instrumentation.ts:99-104` |
| AU10 | Rev4a start (not awaited) | Tag agent images that lost their tags | V4, B-10 | `instrumentation.ts:105-113` |
| AU11 | Rev4a start (not awaited) | Token file mode repair (FL5) | P1 (`/root/.agent-token`) | `instrumentation.ts:114-132` |
| AU12 | Rev4a start | Prune lifecycle job rows | none | `instrumentation.ts:133-143` |
| AU13 | Daemon | Costs (FL11), sessions (FL12), packages (FL13), metrics and OOM (FL14), spend alarms on the stored figures | C1, R1-R3, C4, J1-J5, B7-B11 | `daemon.js:1441-1629` (timers), `lib/spend-alerts.js` |
| AU14 | Every agent boot (entrypoint) | `doctor --fix` on a version change; image defaults; packages restore in the background; token mode decision; gateway start | C7-C9, KR10, KW12, P3, B5, B22, V11 | `agent-templates/base-image/entrypoint.sh:11-133` |
| AU15 | After create, recreate, edit, update, rollback, start, restart, restore or failed-update resolution of one agent (in the background) | Credential re-apply when the Gateway is ready; runtime config application schedules it too | C20-C23, R4-R5, KW11 | `lib/credentials/delivery.ts:643-662` (`reapplyWhenReady`); `lib/agent-setup.ts:174-190`; `lib/agent-update.ts:582`; `app/api/agents/[id]/restart/route.ts:33` |
| AU16 | After a successful update | Image retention | V14 | `lib/agent-update.ts:303-306`; `lib/agent-images.ts:433-462` |
| AU17 | Rev4a start after startup sync (not awaited) | Retry the old timeout/exit-137 switch-ons and native credential assignments with a Gateway token mismatch on running agents. Wait for readiness, retry pending removals before mismatched switch-ons, and log an outcome per agent. | C20-C23, R4-R5, KW11 | `instrumentation.ts`; `lib/credentials/delivery.ts`, `repairCredentialTimeoutsAtStartup` |

## I. Text that tells agents and users how OpenClaw behaves

A behaviour change in a release can make this text wrong without breaking any code. The
evaluation greps these for every behaviour its report changes (tool names, Skill Workshop,
heartbeat, cron, credentials, bootstrap files).

| What | file:line |
|---|---|
| Rules injected into every agent session: workspace path, config ownership, credentials through OpenClaw, `gateway_exec` on the Codex runtime, what survives a recreate | `rev4a-rules/AGENTS.md:3-62` (`gateway_exec` `:36-37`) |
| Template instructions and bootstrap files | `agent-templates/*/AGENTS.md`, `agent-templates/atlas/HEARTBEAT.md`, `agent-templates/custom/BOOTSTRAP.md`, `agent-templates/*/TOOLS.md` |
| PULSE assistant page hints (updates, subscriptions, costs, credentials version floors, Context page caps and file set, plugins) | `app/api/assistant/route.ts:28-30,48,58,84,106-108,118` |
| UI copy that states OpenClaw facts (memory need, browser approval) | `app/components/ui/MemoryLimitPicker.tsx:9-15`; `app/agents/BrowserAccessSection.tsx:6` |
| User and developer docs | section F; `docs/rag/` |

## J. Side findings (noticed while reading, not part of the inventory proper)

1. **Bundled-skill guard path mismatch**: `app/api/skills/save/route.js:12` uses `/usr/lib/node_modules/openclaw/skills`, while the real path (and `app/api/skills/route.js:14`) is `/usr/local/lib/node_modules/openclaw/skills`. The "Bundled skills are read-only" refusal (`save/route.js:115-117`) can never match the path the Skills page lists; whether a write then goes through depends on the container branch.
2. **`/api/agents/config-json` masks only `gateway.auth.token`** (`app/api/agents/config-json/route.ts:47-51`): `channels.telegram.botToken`, `models.providers.rev4a.apiKey` and plaintext `skills.entries.trello.env` values (KW11) reach the browser.
3. **Create swallows every post-start config error** (`app/api/agents/create/route.ts:421-423` `catch {}`): model, Control UI policy and `update.checkOnStart` can be silently missing on a new agent.
4. **Daemon cost pass deletes the window before inserting** with `num()`-defaulted fields (`daemon.js:1019-1041`): a renamed OpenClaw field zeroes 30 days of history, not just the new rows.
5. **Stale template path**: `agent-templates/atlas/AGENTS.md:14-15` points agents at `~/.openclaw/shared-skills/…`; the mount is `/data/.openclaw/shared-skills` (`lib/agent-setup.ts:35`).
6. **Daemon `COSTS_GATEWAY_CLI` is a hand copy** of `lib/gateway-cli.ts` (`daemon.js:846-855`, "Keep the two identical"); no test compares them.
7. **Stopping an agent does not keep it out of Sync All** (B25, FL1-FL3): `getAgentContainers` uses `docker ps -a` (`app/api/gateway/sync.ts:151-168`) and a stopped agent's `openclaw.json` is rewritten through `docker cp` (`:234-253`). Only the P8 deletion and the in-container reads skip stopped agents. An evaluation instance that must not touch the owner's agents has to avoid the sync itself (no changed sync/setup code, or a separate Docker host), not only stop them.
8. **`agents.list` is absent from the 2026.9.9 and 2026.10.10 config schemas** (KR2, KW6): `app/api/gateway/agent/route.ts:165-178`, `lib/subscriptions.ts:511-573` and `lib/credentials/runtime.ts:25-27` still read and write it, and nothing reads `agents.entries.main.model` (KR13). Found by comparing the schemas, not reproduced on a live agent.
