---
name: rev4a-openclaw-upgrade
description: Evaluate a new OpenClaw release for Rev4a's agents before Rev4a offers it, then take it to users safely. Two tracks. The full track (a new YYYY.M line, or any escalation trigger) compares the releases statically (npm packages, config schema, docs, release bodies), then tests them live on throwaway local agents through Rev4a itself - seed, snapshot, update, compare, behaviour, a rehearsal on a copy of real data, an update from the oldest supported version, fresh create, memory and startup, rollback - and ends with a release gate (published multi-arch image, revision pin, release order, canary, withdraw plan). The minor track (a later release or a -N hotfix on a line Rev4a already ships) keeps every cheap check and drops only what triage.mjs shows to be unnecessary. Both end with an independently checked report of blockers, Rev4a fixes, owner decisions and the five upgrade-safety answers. Use for "new OpenClaw version", "evaluate OpenClaw 2026.x", "OpenClaw hotfix", "can we move agents to …", "upgrade OpenClaw", "OC-<n>" cards about an OpenClaw bump.
---

# Evaluate a new OpenClaw release

Rev4a runs other people's agents. An OpenClaw release that breaks one thing Rev4a reads breaks it on
every install that updates (AGENTS.md §2.2c). Release notes are not enough: 2026.9.9 → 2026.10.10
stated no breaking change, yet it broke Rev4a's Update on every agent, did not fit the memory limit
Rev4a recommends, and dropped a skill-approval option. This procedure found all three in one afternoon.
Follow it in order; skip a step only with a written reason in the report.

Read before starting:
- `references/inventory.md`: every place Rev4a depends on OpenClaw, with call sites and how each
  fails. The evaluation is checked against it.
- `references/history.md`: earlier evaluations and the traps. Read the traps in full.
- `references/report-template.md`: the shape of the full and the minor report.

## Rules

1. **Never touch an agent someone uses.** The owner's agents and production agents are never seeded,
   snapshotted, updated, restarted, memory-limited, synced or restored. Test agents are throwaway agents
   whose Rev4a name starts with `oc-eval-`; the scripts refuse any other agent. `--i-own-this-agent`
   lifts the refusal of `snapshot.mjs` only for an agent the owner names; never pass it to `seed.mjs`.
2. **Fleet actions reach every agent, stopped ones included.** The inventory lists them
   (`references/inventory.md`, section G, FL1-FL20) and the code that runs without a user action
   (section H, AU1-AU16). A user-triggered fleet write (Sync All or a provider save on the Gateway page,
   FL3; token rotation, FL4; promoting or deleting a shared skill; credential re-delivery, FL10) needs the
   owner's ok for that one action. Stopping the owner's agents does **not** make a fleet write safe:
   Sync All lists agents with `docker ps -a` and writes `openclaw.json` into stopped ones with
   `docker cp` (`app/api/gateway/sync.ts`). A branch instance served by the maintainer's review tooling
   in full mode uses the owner's real shared folder. Fleet reads (FL15-FL20, `snapshot.mjs --fleet`)
   cost 100-360 MB per agent per CLI start: keep those pages closed during the live steps.
3. **The branch's Rev4a may serve the owner's Docker host only when it writes what the owner's own
   instance writes.** Every start runs the startup Sync All (FL1/AU4) and then the price-band re-sync
   every minute (FL2/AU5) on every agent, running or stopped. This is allowed only when
   ```bash
   git diff --stat main -- instrumentation.ts app/api/gateway/ lib/agent-setup.ts lib/agent-versions.ts \
     lib/price-schedule-sync.ts lib/model-pricing* rev4a-rules/ bin/rev4a.js
   ```
   prints nothing, and TO's `modelInput` equals every other listed version's (otherwise
   `conservativeModelInput()` in `lib/agent-versions.ts` changes what agents of unknown version get).
   Otherwise the live steps run on a **separate Docker host** that holds no agent anyone uses; say so to
   the owner before step 3.
4. **While the branch lists TO, it offers TO to every agent.** The Agents page shows Update on the
   owner's agents, and a new agent the owner creates lands on TO. Tell the owner before step 4: nobody
   presses Update and nobody creates agents on this Rev4a until the evaluation ends.
5. **One Rev4a per Docker host.** The branch instance replaces the owner's instance on :3740 (two
   instances write the same agent configs). Keep the owner's instance down as little as possible.
6. **Mind the host.** Apply the memory formula (Prerequisites) before every create or start. Run at
   most two test agents at a time; stop each one when its step is done; take snapshots one at a time.
   An evaluation once got an owner's Gateway killed by a global out-of-memory.
7. **Local first.** Building an image is fine. Publishing an image, writing to a server, committing,
   pushing, merging and creating cards need the owner's explicit ok, each time.
8. **The owner signs in.** The ChatGPT/Codex login is the Connect button on the Subscriptions page. The
   owner presses it; never start or relay a device code for them.
9. **Verify before you claim.** Every finding needs evidence: a file:line in the published package, a
   command output, a snapshot item or a log line. A behaviour change needs the OLD release's doc or code
   too: on 2026.10.10 a "new default" was the old default as well. A word match is not proof: open the
   code.
10. **Never restart Rev4a or a test agent during an update, a restore or a rollback.** A Rev4a restart
    marks the update `interrupted` (`recoverInterruptedUpdates`, called from `instrumentation.ts`) and
    creates a second problem.
11. **Stop when "When something fails" says so.** Leave everything as it is and tell the owner.

## Prerequisites

| Need | Detail |
|---|---|
| Tools | Docker running; Node ≥ 22.13 on the host (the scripts use Node built-ins only; `neutralize-backup.mjs` needs `node:sqlite`); `npm` with registry access; `git`; `gh` signed in (`release-diff.mjs --notes` exits 1 without it; then read the bodies on the GitHub releases page, and T10 stays `unverified`); `sqlite3` and `lsof` when the maintainer's review tooling is used. macOS has no `timeout`: use the commands' own timeouts. |
| Disk | About 1.5 GB under `$REV4A_UPGRADE_WORK` (two unpacked `openclaw` packages of about 270 MB in its `releases/` cache, notes, snapshots); about 5 GB for Docker (two or three images of about 2 GB, build cache); in the branch's backups folder, 60 % of each test agent's volume per backup (`lib/cold-backup.ts` refuses below that) and the size of the real backup used in step 5. Start with 15 GB free where Docker stores images and volumes; stop under 5 GB. |
| Memory | `sum of the memory limits of every agent that will run at the same time + 1 GB ≤ Docker MemTotal`. An agent with no limit counts as its current `docker stats` usage + 1 GB. When it does not hold, stop and ask the owner to stop agents or to pick a bigger host. |
| Host continuity | A laptop stays on AC power for live tests. Prevent idle sleep without changing permanent power settings. Record sleep/wake evidence if observation pauses: suspended-host intervals invalidate readiness, timeout and observation measurements. |
| Owner | Available for the up-front ok, the Connect step, the oks listed in Rules, and the end. Told that their Rev4a instance is replaced for a while and that their agents must not be updated from it. |
| Secrets | The scripts call the API with `Authorization: Bearer <REV4A_TOKEN>` (the environment, else the `.env` named by `REV4A_ENV_FILE`, `$REV4A_DATA_DIR/.env` or `~/.config/rev4a/.env`), never printed: it must be the token of the instance under test. The branch's data copy holds `.env`, `provider-keys.json` and the databases: it stays outside the repository and is removed at the end. |

```bash
docker info --format '{{.MemTotal}}'                                              # bytes
docker ps -q | while read -r id; do docker inspect --format '{{.Name}} limit={{.HostConfig.Memory}}' "$id"; done   # 0 = no limit; nothing when none runs
docker stats --no-stream --format '{{.Name}} {{.MemUsage}}'
docker system df
```

Time, measured on 2026.10 (full track: about one working day without a soak; minor track: 2-3 hours,
mostly waiting):

| Steps | Time | Cost |
|---|---|---|
| 0-2 scope, static, image | 20-40 min downloads, 30-60 min reading, 8-15 min build | none |
| 3-4 test agents, offer TO | 2-3 min per create, 1 min seed, 5 min restart | one chat turn |
| 5 rehearsal | 30-60 min | none |
| 6-7 update, compare, behaviour | 2-4 min per snapshot and update, 30-60 min checks | a few chat turns |
| 8-10 oldest source, create and memory, rollback | 60-90 min | none |
| 11-12 report, checker, clean up | 45-90 min | one checker sub-agent |
| optional observation, after all functional tests | 1-2 h, agreed with the owner | ordinary health checks; model calls only when explicitly in scope |

## Setup

1. **Up-front ok.** Ask the owner once for the throwaway resources this run creates and deletes: the
   `oc-eval-*` agents with their volumes and backups, the local TO image, the branch instance and its
   data copy, the work directory. Anything else (a fleet action, a shared skill, an orphan volume, the
   owner's agents, a publish, a commit) still needs its own ok.
2. **Worktree and branch instance.** Work on a branch from `main` in a git worktree. With the
   maintainer's review tooling (`wt-new.sh` / `review-up.sh`), when available, use it to create the
   worktree and to serve it on :3740 with a copy of the owner's data (its README says how). Without it:
   build the branch and run it on :3740 with `REV4A_DATA_DIR` pointing at a copy of the data directory.
3. **Placeholders.** Run everything from the worktree root, with these defined once per shell:
   ```bash
   FROM=<newest released version>          # step 0
   TO=<candidate version>                  # step 0
   OLDEST=<oldest version listed on main>  # step 0
   CARD=<card id, e.g. OC-12>
   S=skills/rev4a-openclaw-upgrade/scripts
   export REV4A_UPGRADE_WORK="$HOME/rev4a-openclaw-upgrade"   # the scripts' base folder: on disk, never a tmpfs
   WORK="$REV4A_UPGRADE_WORK/$FROM-$TO"; mkdir -p "$WORK"               # this run's folder
   export REV4A_BASE_URL=http://localhost:3740
   # Rev4a API as admin: r4 <METHOD> <path> ['<json body>'] prints the HTTP status and the answer.
   # 10-minute timeout: a create answers only after the agent's readiness wait. It always exits 0,
   # even on an HTTP error: read the status it prints (or the JSON's `error`), never its exit code.
   r4() { node --input-type=module -e 'import { api } from "./skills/rev4a-openclaw-upgrade/scripts/lib.mjs";
     const [m, p, b] = process.argv.slice(1); const r = await api(m, p, b ? JSON.parse(b) : undefined, { timeoutMs: 600000 });
     console.log(r.status, r.json ? JSON.stringify(r.json, null, 2) : r.text);' "$@"; }
   ```
   `$REV4A_UPGRADE_WORK` must be the same folder in every shell of the run and must survive a reboot:
   it holds the package cache and `park-tag.mjs`'s `parked.json`. Where `/tmp` is a tmpfs (Debian 13,
   Fedora, Arch: `findmnt -n -o FSTYPE /tmp` prints `tmpfs`) it would sit in RAM and be lost; hence a
   folder under `$HOME`. If home itself is a Git tree (a dotfiles repository), choose a persistent
   disk directory outside that tree instead: the scripts correctly refuse outputs anywhere below
   a Git root. Write the values of this block in the run log (step 5).
   `$CAND`, `$REH`, `$OLD`, `$FRESH` are the test agents' `AGENT_ID` labels (`agent_xxxxxxxx`, also the
   container names), set when step 3 and step 9 create them. `<data dir>` is the owner's Rev4a data
   directory (`REV4A_DATA_DIR`, default `~/.config/rev4a`); `<branch data dir>` is the branch's copy.
4. **Work directory.** Every script takes `--work "$WORK"` (without it, they use
   `$REV4A_UPGRADE_WORK/run`, or `<tmpdir>/rev4a-openclaw-upgrade/run` when that variable is unset) and
   writes there under fixed names: `release-diff`, `schema-diff`, `rev4a-deps`, `compare`, `triage`
   (each `.md` for people and `.json` for `triage.mjs`, side by side), `seed.json`, and one
   `snap-<label>/` folder per snapshot (`index.md`, `index.json`, one file per item). `--out` moves a
   report; its `.json` follows it, and `triage.mjs` reads only the default names in `--work`. The
   package cache (`releases/`) and `park-tag.mjs`'s state (`parked.json`) live in
   `$REV4A_UPGRADE_WORK` and are shared across runs. Every output must be outside a git tree: the
   scripts refuse one inside (the review tooling stages the whole worktree, and these files hold
   hundreds of MB of agent data). Exit codes: 0 ran fine, 1 usage or environment error, 2 no
   trustworthy result (never read the output of an exit 2 as a finding); `triage.mjs` adds 3.
5. **Run log.** Keep `$WORK/log.md`: one line per step with the time, what ran, the ids created
   (agents, ports, images, backups), which instance serves :3740, and what is still running. First line:
   the owner's agents,
   `docker ps -a --filter label=AGENT_ID --format '{{.Names}} {{.Status}}'`.
   The display name is `AGENT_NAME` in container environment, not a Docker label; read it via
   `GET /api/agents` or the script helper, never print the full environment. On resume, in a new shell: first define the placeholders of step 3 again from the run log (the same
   `FROM`, `TO`, `OLDEST`, `CARD`, `S`, `REV4A_UPGRADE_WORK`, `WORK`, `REV4A_BASE_URL`, the `r4` function
   and the test agents' ids), then read the log, run that command and `node $S/park-tag.mjs status`,
   before anything else.
6. **Card.** With the owner's ok, put the card in progress on the project's tracker with the versions
   and `$WORK`.

## 0. Scope

1. `FROM`: the newest **released** version, the first entry of `lib/agent-versions.json` on `main`
   with an `imageRevision` (`git show main:lib/agent-versions.json`). `OLDEST`: the last entry there.
   Every listed version is an update source users have: `runUpdateStart` (`lib/agent-update.ts`)
   accepts any newer supported target.
2. `TO`: the `latest` dist-tag, or the version that carries the motivating fix.
   ```bash
   npm view openclaw dist-tags
   npm view openclaw time --json | grep "\"$(echo $TO | cut -d. -f1-2)\."    # the line's releases, with dates
   gh issue list -R openclaw/openclaw --search "$TO in:title,body" --state open --limit 30
   ```
   Prefer the newest patch of the line. A version published less than 48 h ago: tell the owner, a
   hotfix often follows. A `-N` listed only under a non-`latest` dist-tag is a prerelease, not a candidate.
3. Write down why: the fix or feature that motivates the move. For a fix, find its PR and the code it
   changes; step 1 proves that code is in the TO package.
4. Choose the track (next section) and write it in the run log.

## Choosing the track

OpenClaw versions are `YYYY.M.D`, with `-N` for a hotfix. A new **line** (`2026.9.x` → `2026.10.x`)
brings schema migrations and retirements: always the **full track** (steps 1-13). A later release on a
line Rev4a already ships (`2026.10.10` → `2026.10.14`, or `2026.10.10-1`) may take the **minor track**
when every row of `triage.mjs` allows it and, checked by hand, none of the line's blockers in
`references/history.md` is still open.

`triage.mjs` reads the `.json` files in `$WORK` and writes `triage.md` and `triage.json`, one row per
precondition (P1-P4) and trigger (T1-T15), each `ok`, `full` (escalate), `check` (minor track plus the
named check), `open` (a live trigger whose input does not exist yet) or `unverified` (its input cannot
answer: **counts as `full`**):
```bash
node $S/triage.mjs --work "$WORK"
```
Exit 0: the minor track is allowed so far (`open` rows remain) or allowed. Exit 3: escalate; the
verdict names the rows. Exit 2: `release-diff.json`, `schema-diff.json` or `rev4a-deps.json` is missing
in `$WORK`, or an input is for other versions (an image tag that is not `:$FROM`/`:$TO`, a `compare.json`
whose B does not run TO or whose A is newer than FROM); produce it again and rerun. A schema file whose
name does not hold the version is a warning at the top of `triage.md`. It needs all three static inputs, so the first run is at the end
of step 2. Until `compare.json` exists, T12-T15 are `open`; once it exists every row must answer, so
the final run is at the end of step 9, after `manual.json` is written (step 9.6). On the full track
(a new line) P2 is always `full`: the rows are still the evidence for the report. An escalation keeps
the steps already done and continues the full track from the step the row names.

**The 10.x line today:** P3 keeps the minor track closed until a full 10.x evaluation is recorded
as `**Verdict:** go`. The pairing loader (`lib/channel-pairing-store.js`) prefers the public async
reader, retaining `readChannelAllowFromStoreSync` only as a legacy fallback. That fallback's final
compatibility day is 2026-12-31. T8's static dependency scan is conservative: a deprecated name in
the loader can still trigger a full run even when TO uses the public branch. Record the actual
capability path; do not claim TO called the deprecated reader merely because its name is present,
and do not remove older-agent support just to silence the trigger. Follow T8's full-track result.

| # | Row (as `triage.mjs` evaluates it) | Input | Escalates to |
|---|---|---|---|
| P1 | FROM is in `lib/agent-versions.json` with an `imageRevision` | the worktree's `lib/agent-versions.json` | full |
| P2 | TO is newer than FROM on the same `YYYY.M` line | the versions | full |
| P3 | `references/history.md` has a full evaluation of TO's line (a heading `## … → YYYY.M.D (…)` without `(minor`) whose entry has the line `**Verdict:** go` | `history.md` | full |
| P4 | TO is the npm `latest`, or a `-N` hotfix of it | `release-diff.json` (`unverified` after `--offline`) | full |
| T1 | A `*SCHEMA_VERSION` constant changed | `release-diff` | full |
| T2 | A `RETIRED_*` declaration is new, or a `RETIRED_*`/`SYSTEM_OWNED_*` value changed | `release-diff` | full |
| T3 | `engines.node` or the Node security floors changed | `release-diff` | full from step 2 |
| T4 | A bundled skill or plugin was removed, or a hook, skill or plugin id Rev4a names (`rev4a-deps` ids) is not in TO (`unverified` when `rev4a-deps` had no TO package) | `release-diff`, `rev4a-deps` | full |
| T5 | A documented config key is gone, or a key Rev4a uses changed type or default | `release-diff` | full |
| T6 | A schema path removed; a type or option lost; a default changed on a key Rev4a uses; a change under `models.providers.<key>.models[].input`; a Rev4a key `MISSING` or a value `NOT ACCEPTED`; a path TO migrates or retires that Rev4a names in code (comments are skipped) and that FROM's rules did not already migrate | `schema-diff`, `rev4a-deps` | full |
| T7 | A CLI page, subcommand or flag Rev4a runs is gone (`unverified` when `rev4a-deps` had no TO package) | `release-diff`, `rev4a-deps` | full |
| T8 | An internal Rev4a imports is missing, unexported, newly deprecated, or due for removal within 90 days (`unverified` while `rev4a-deps` ran without `--to-image`) | `release-diff`, `rev4a-deps` | full |
| T9 | A new doc line about a retirement, removal, rename or default in an inventory area | `release-diff` | full |
| T10 | A release body says breaking, migration, removed or deprecated about an inventory area (`unverified` without `--notes`) | `release-diff` | full |
| T11 | `@openclaw/codex` changed its `openclaw` peer range or its `@openai/codex` dependency | `release-diff` | `check`: minor + the Subscription row of step 7 with the owner's Connect |
| T12 | The migrated config does not validate on TO, or sets a path TO does not know (errors on `<redacted>` values excepted) | `schema-diff.json` from the `--config` run of step 6 | full |
| T13 | A snapshot not trustworthy; update not `done`; any `blocker-candidate` of `compare.md`'s Triage (an item now failing, a field Rev4a parses lost or retyped, a user cron job, database or workspace skill gone, more restarts or an OOM, memory at 90 % of the limit, a port outside the published block, a past day's cost changed, a Rev4a API answer with an error or `reachable`/`resolvable: false` in B); an OpenClaw-owned cron job, table or volume plugin gone or changed; a database `user_version` changed; a new notable log line. Its `unverified` entries (failing in both, not exercised, fields absent from both) make it `unverified` | `compare.json` | full from step 7 |
| T14 | Idle memory on TO > 115 % of FROM, or > 70 % of the historical2048 MB warning baseline (a conservative escalation test, separate from current target admission), or an OOM (`OOMKilled` or `dmesgOom`); `unverified` while `dmesgOom` is not recorded or a snapshot did not settle | `compare.json`, `manual.json` | full step 9 |
| T15 | Startup on TO > 120 % of FROM, or > 50 % of the create wait | `manual.json` | full step 9 |

## 1. Static comparison (no container)

```bash
node $S/release-diff.mjs --from $FROM --to $TO --notes --work "$WORK"
```
It downloads both packages and the matching `@openclaw/codex` into `$REV4A_UPGRADE_WORK/releases`
(reused by later runs), reads the complete paginated GitHub release list and saves every release body after FROM up to TO in
`$WORK/notes-$FROM-$TO/`, and reports the npm dist-tags, Node and schema versions, bundled skills and
plugins, the codex peer range, CLI pages and the flags Rev4a runs that a page lost, config keys and
defaults, the OpenClaw internals Rev4a imports by name (with deprecation deadlines), `RETIRED_*` and
similar declarations new, gone or changed, and doc lines that announce a retirement, removal, rename,
new default or migration. Exit 1: npm or `gh` unreachable (never read as "not published" or "no
notes"). Publication wrappers (`openclaw-release-publication:docs-v1`) are saved as
`<version>.publication.md`; the substantive changelog, fetched at that release's tag, is
`<version>.md`. A wrapper without a readable recognized changelog is a failure, never checked notes.
Exit 2: no release body found between the two; read the GitHub releases page and say so.
`--offline` uses the cache only; dist-tags, codex and notes are then "not checked" (P4, T10 and T11
`unverified`). For a `-N` TO, check that its own release body is among the saved notes.

Then read, do not skim (sub-agents may read in parallel; see "Using sub-agents"):
1. **Every release body** between FROM and TO; the package CHANGELOG carries only the last release.
   Sort each relevant line by inventory area: cron, channels/Telegram, pairing, devices, plugins,
   skills, sessions, usage and costs, models, secrets, config, doctor, Control UI, Codex/OpenAI auth,
   sub-agents, memory, Node, Docker. Mark every behaviour with a timer or a counter (archived after N
   days, reviewed after N turns): the report lists them under "Time-delayed effects".
2. **Each item of `release-diff.md`** against the inventory rows. For a retired config path,
   `git grep` Rev4a for it.
3. **The stated reason for the evaluation** in TO's package code: plugin or core? Does it need a core
   API FROM lacks? Plugins on the volume are not replaced by a new image: find what TO's
   `doctor --fix` does to installed plugins; step 7 checks version convergence live. A specific
   incident's reproduction or long-term monitoring belongs to its own test plan, not to this
   generic upgrade-compatibility checklist.

## 2. Local image and schema

1. Build for the local architecture, never pushed; no file changes are needed for the build:
   ```bash
   docker build --pull --build-arg OPENCLAW_VERSION=$TO --build-arg IMAGE_REVISION=local \
     -t openclaw-agent-base:$TO agent-templates/base-image
   docker run --rm --entrypoint openclaw openclaw-agent-base:$TO --version
   docker run --rm --entrypoint node openclaw-agent-base:$TO --version
   ```
   `--pull` matters: a stale cached `node:24-bookworm-slim` silently ships an old Node.
2. FROM (and OLDEST, for step 8) must be local. If one is missing, download it in Rev4a:
   `r4 POST /api/agents/download-image '{"version":"<version>"}'`, then poll
   `r4 GET /api/agents/image-status` until `downloading` is false.
3. Compare the full config schema:
   ```bash
   node $S/schema-diff.mjs --from-image openclaw-agent-base:$FROM --to-image openclaw-agent-base:$TO \
     --work "$WORK"
   ```
   Read removed keys, keys now accepted only through a generic map, lost options, changed defaults,
   new keys with a default, and TO's open objects (anything accepted there, nothing checked). Exit 2:
   a schema could not be read.
4. Check what Rev4a depends on (`references/deps.json`) against TO, statically for now:
   ```bash
   node $S/rev4a-deps.mjs --from-image openclaw-agent-base:$FROM --to-image openclaw-agent-base:$TO \
     --work "$WORK"
   ```
   It checks the config keys Rev4a writes and reads (and the values it writes) against both schemas,
   the CLI commands and flags against TO's docs and `--help` in the image, the hook, skill and plugin
   ids Rev4a names, the internals Rev4a imports (loaded inside the image, never on the host), and the
   paths TO migrates or retires that Rev4a's code still names. It reads the TO package from
   `release-diff.json`. Always pass `--from-image`: without FROM's schema a key missing from both
   releases reads `MISSING` (a new break) instead of "missing in FROM and TO", and T6 escalates.
   Anything it could not check is listed as unverified, never as passed. `deps.json` is a subset of
   the inventory: check the "keys written" rows it does not list (`lib/agent-setup.ts`, the
   Dockerfile's `config patch` lines, `entrypoint.sh`) against `schema-diff.md` by hand.
5. TO's `modelInput` is the enum of `models.providers.<key>.models[].input[]` in TO's schema. Equal to
   FROM's: copy FROM's list. A lost value is a blocker in `lib/agent-versions.ts`.
6. Run `triage.mjs`. Exit 3 on the minor track: switch to the full track.

## 3. Test agents (before TO is listed)

Rev4a creates agents on the newest **listed** version it has locally (`newestLocalSupportedVersion`,
`lib/agent-images.ts`, used by `app/api/agents/create/route.ts`). So every test agent on an older
version is created while the branch does not list TO yet; the TO image may already exist.

1. Stop the owner's instance and start the branch instance **without** the version lines (Rule 3
   first). `r4 GET /api/agents/image-status` shows `newestLocal` = FROM.
2. For each agent pick: a block of 10 free ports (neither `docker ps --format '{{.Ports}}'` nor
   `lsof -nP -iTCP -sTCP:LISTEN` shows them); the cheapest `rev4a/*` model the create wizard offers,
   never a subscription model; a memory limit of at least the target release policy (4096 MB for 2026.10.10; smaller caps produced false findings).
3. Create them one at a time, apply the memory formula before each, and stop each one after seeding
   (`r4 POST /api/agents/<id>/lifecycle '{"action":"stop"}'`):
   ```bash
   r4 POST /api/agents/create '{"name":"oc-eval-<card>-candidate","template":"custom","portRange":"<p>-<p+9>","model":"<model>","fallbacks":[],"memoryLimitMb":4096}'
   ```
   | Agent | Name suffix | Version | Used in |
   |---|---|---|---|
   | `$CAND` | `-candidate` | FROM | steps 6, 7, 9, 10 |
   | `$REH` | `-rehearsal` | FROM | step 5 (full track) |
   | `$OLD` | `-oldest` | OLDEST | step 8 (full track) |

   `$OLD` needs every local tag of a listed version newer than OLDEST parked (moved to
   `rev4a-parked/openclaw-agent-base:<v>`, same image, nothing deleted) for the minutes of its create,
   with no other Rev4a action running. `<newer>` is the comma-separated list of those versions that
   `docker images openclaw-agent-base` shows (FROM at least):
   ```bash
   node $S/park-tag.mjs park --version <newer>
   r4 POST /api/agents/create '{"name":"oc-eval-<card>-oldest", …}'
   node $S/park-tag.mjs restore --version <newer>
   node $S/park-tag.mjs status              # "nothing parked"
   ```
   `park` restores what it already parked when one tag fails. After an interrupted session, `status`
   lists what is still parked, from its state file and from the `rev4a-parked/openclaw-agent-base` tags
   Docker holds (so a lost `parked.json` still shows them), and `restore --all` puts all of them back
   (`run --version <newer> -- <command>` parks, runs an executable and restores in every case, but
   cannot run the `r4` shell function). A
   tag left parked makes every later create silently use an older version; running containers keep
   running, but nobody may recreate or update an agent while a tag is parked.
4. Seed `$CAND`, so the snapshots are not empty, then `$OLD` in its own folder (`seed.json`, which
   the snapshots record, is one per `--work`):
   ```bash
   node $S/seed.mjs --container $CAND --all --work "$WORK"
   node $S/seed.mjs --container $OLD --all --work "$WORK/oldest"
   ```
   Always: a command cron job `rev4a-upgrade-seed` with one run and a workspace skill. `--all` adds an
   agent-turn cron job with one run (`--agent-cron`, on the agent's primary model or `--model`), one
   chat turn (`--chat`), a turn that asks for a sub-agent (`--subagent`; a WARN when the model starts
   none) and a Telegram channel with a fake token (`--telegram`; the Gateway logs Telegram 401s until
   it is removed). Three or more model turns on the cheap model. Exit 1 on any FAIL. It cannot seed a pending
   pairing request (needs a real bot), subscription usage (the owner's Connect), a credential or a
   shared skill. On `$CAND`, before the update, do two of those by hand: switch on one test credential
   (a fake key, Credentials page), and open its Control UI in a browser that is not approved, so the
   devices list holds a pending entry.
5. **FROM's startup** (for T15): on `$CAND`'s first start, the time from the first `docker logs -t`
   line with `[entrypoint] Starting gateway` to the first successful `/startupz`. Write it in the run
   log: the update recreates the container and its log.
6. When Subscriptions are in scope, the owner presses Connect on `$CAND` on FROM. Record connected
   state and a successful model turn as the authentication-preservation baseline; no mandatory
   reproduction or soak for a particular provider incident.

## 4. A Rev4a that offers TO

1. In the worktree:
   - `ARG OPENCLAW_VERSION=$TO` in `agent-templates/base-image/Dockerfile`;
   - TO at the top of `lib/agent-versions.json`, without `imageRevision`, with step 2.5's `modelInput`.

   These lines make Rev4a offer TO. They reach `main` only through step 13.
2. Restart the branch instance so it serves them (Rule 3 again; no update, restore or rollback may be
   running). The TO image must be local first: a Rev4a whose first listed version is missing pulls it
   at `rev4a serve`, and builds it when the pull fails, before the dashboard starts
   (`ensureAgentImage`, `bin/rev4a.js`). The maintainer's `review-up.sh` rebuilds (3-5 min) and
   **replaces the data copy**, which holds the update rows: restart it here, before step 5, and never
   again until step 12.
3. `r4 GET /api/agents/image-status` shows `newestLocal` = TO. Tell the owner (Rule 4).
4. Write `docker images openclaw-agent-base` in the run log. A successful update untags every agent
   image that no container uses and that is not one of the two newest versions (`pruneAgentImages`).

## 5. Rehearsal on real data (full track)

Fresh agents hide what real ones carry: large databases, dozens of skills, third-party plugins, an old
codex plugin, custom config keys. Restore a neutralized copy of a real backup into `$REH`.

1. With the owner's ok, pick one real backup (plain files in `<data dir>/backups`, `lib/backups.ts`):
   the largest, the oldest, or the one with Codex connected. Never touch the original.
2. **Neutralize the copy before any container sees it.** A restore starts the agent as soon as the
   archive is extracted (`lib/agent-restore.ts`): a live bot token would poll Telegram next to the real
   bot, a cron job would deliver for real, a credential would act for real. Write the copy straight
   into the branch's backups folder under the rehearsal agent's name, which a restore requires
   (`isValidBackupFile`, `lib/backups.ts`):
   ```bash
   REHF="agent-$REH-cold-$(date +%Y-%m-%d_%H%M%S)000.tar.gz"
   node $S/neutralize-backup.mjs --in "<data dir>/backups/<real backup>.tar.gz" \
     --out "<branch data dir>/backups/$REHF"
   ```
   The input is only read. In `openclaw.json` it removes `channels` and their `bindings`, sets
   `cron.enabled` to `false`, removes the Gateway token or password, the Rev4a provider's key and its
   `x-rev4a-agent` header, `skills.entries.*.env` and `.apiKey`, and replaces every other string under
   a secret-looking key (token, apiKey, password, secret…) with `rev4a-neutralized`. In the state
   database it deletes the `secret_store_entries` rows and the stored sign-ins (`authProfiles.store`),
   then vacuums it. It drops `.agent-token`, `.openclaw/credentials/`, `agents/*/agent/auth-profiles.json`,
   `agents/*/agent/models.json` (copies of the provider settings, keys included), `.openclaw/.env`,
   `.codex/` and the CLI credential files Rev4a's detection knows (gh, vercel, supabase, trello,
   notion). It prints every change; read the list. Exit 2: an archive shape it does not handle safely
   (nothing written): stop and ask the owner.

   **What it keeps:** transcripts, memory, workspace files and every other database (personal data
   remains: the copy stays on the owner's host, with the owner's ok, and is deleted at step 12), and
   plugin settings under keys that do not look secret. Anything there that could reach someone (a
   plugin with its own channel or webhook): stop and ask the owner.
3. Restore it into `$REH`: `r4 POST "/api/agents/$REH/restore?file=$REHF"`, poll
   `r4 GET /api/agents/$REH/restore`. `$REH` starts on FROM with the real data and no provider key: it
   cannot call a model until a per-agent provider sync, which the update in 5.5 performs.
4. Validate the real config on TO (read-only, no network; `channels` were removed, so the candidate's
   migrated config in step 6 is the channel check):
   ```bash
   mkdir -p "$WORK/rehearsal" && tar xzf "<branch data dir>/backups/$REHF" -C "$WORK/rehearsal" ./.openclaw/openclaw.json
   node $S/schema-diff.mjs --from-image openclaw-agent-base:$FROM --to-image openclaw-agent-base:$TO \
     --config "$WORK/rehearsal/.openclaw/openclaw.json" --out "$WORK/schema-diff-real.md"
   ```
   With the owner's ok, repeat for each other real backup (a neutralized copy in `$WORK`, no container).
5. Update `$REH` to TO (step 6's update and poll, no snapshots) and measure: the baseline and backup time,
   `doctor --fix` time (the agent's log), the whole update against the 10-minute first window
   (`MIGRATION_READY_TIMEOUT_MS`), peak memory (`docker stats --no-stream` every 5 s), the
   `*.pre-startup-migration-*.bak` bytes, and skills, plugins and pending Skill Workshop proposals
   before and after.
6. Roll it back (step 10's command), then stop it.

## 6. Snapshot, update, snapshot, compare

```bash
node $S/snapshot.mjs --container $CAND --label before --work "$WORK"           # → $WORK/snap-before
r4 POST /api/agents/$CAND/update "{\"version\":\"$TO\"}"                     # or the Agents page button
while :; do r4 GET /api/agents/$CAND/update | head -20; sleep 15; done        # Ctrl-C at a final status
node $S/snapshot.mjs --container $CAND --label after --work "$WORK"            # → $WORK/snap-after
node $S/compare.mjs "$WORK/snap-before" "$WORK/snap-after" --work "$WORK"      # → compare.md, compare.json
node $S/rev4a-deps.mjs --from-image openclaw-agent-base:$FROM --to-image openclaw-agent-base:$TO \
  --work "$WORK"                                       # now also checks the fields against both snapshots
node $S/schema-diff.mjs --from-image openclaw-agent-base:$FROM --to-image openclaw-agent-base:$TO \
  --config "$WORK/snap-after/file.openclaw-json.raw" --work "$WORK"            # T12 reads this run
```

- The candidate must be **running** (`runUpdateStart` refuses a stopped agent).
- Browser requests expire after five minutes in 9.9 and 10.10. The request from step 3 may have
  expired during the real-data rehearsal. After the before snapshot, reopen that fresh browser
  profile, record its new pending request, then start the update. Read and approve it as soon as the
  update finishes, before the after snapshot; record that deliberate approval as an expected change.
  Expiry during a long update is not migration loss: reopen the same browser and test approval on TO.
- `snapshot.mjs` checks first that the container runs, that its Gateway answers `/startupz` "started"
  within `--settle` + 300 s, and that this Rev4a lists it (`GET /api/agents`); any failure is exit 2
  with `ok:false` in `index.json` (often a wrong `REV4A_BASE_URL` or `REV4A_TOKEN`). It then waits
  until the container has been up `--settle` seconds (default 180) with CPU under `--max-cpu`
  (default 80 %), retries each failed item once after `--retry-wait` seconds (default 30), and exits
  2 when more than a third of the required items still fail. It refuses an agent whose Rev4a name is
  not `oc-eval` or `oc-eval-…` (Rule 1), and a non-empty folder unless `--force`, which empties it.
  It is not quite read-only: `openclaw dashboard --json` issues a single-use Control UI link. Never
  pass `--fleet` (Rule 2) unless the other agents are stopped.
- `compare.mjs` refuses (exit 2) a snapshot that is incomplete, failed or from an older
  `snapshot.mjs`, unless `--allow-incomplete`, used only with a written reason in the report.
- The `--config` run rewrites `schema-diff.md` with the same schema comparison plus the migrated
  config: the paths TO does not know, those under an open object, and `openclaw config validate` on a
  copy inside the TO image. An error on a `<redacted>` value is "not judged", not a finding.
- A small agent's update: backup 10-30 s, migration and start 1-3 min, verification under 1 min. Past
  the limits in "When something fails", stop.
- **Read the update's own result first.** `failed` with a verification text is a finding about Rev4a's
  update flow, not about the agent: on 2026.10 OpenClaw deleted one of its own cron jobs on purpose.
- Read `compare.md`'s Triage section first. Items empty or failing on both sides are "not
  exercised", and fields Rev4a parses that are absent from both snapshots are listed: they prove
  nothing; say so in the report. Then `rev4a-deps.md`, whose field check (C2) now reads both snapshots.

Classify every difference, in writing:
- **expected**: documented by OpenClaw and harmless to Rev4a;
- **Rev4a fix needed**: Rev4a reads, counts or writes the changed thing;
- **owner decision**: a behaviour change users will notice;
- **OpenClaw defect**: report it upstream if it matters.

## 7. Behaviour on TO

On the updated candidate, through Rev4a (the API or the page). `…` stands for `/api/agents/$CAND`.
Write each result with its evidence.

| Area | Check |
|---|---|
| Model | `PUT /api/gateway/agent {"containerName":"<id>","model":"rev4a/<other>","fallbacks":[]}` and back; `openclaw.json`, `openclaw models list --provider rev4a --json` and `GET …/model` agree |
| Provider sync | The update ran the per-agent provider patch: the `rev4a/*` models are listed with the right input types. The fleet path (whole-file write, then `rm` of `models.json` and `auth-profiles.json`, FL1/FL3) on a TO agent: with the owner's ok, press Sync All Agents on the Gateway page (it writes what the owner's own instance writes, Rule 3; restarting the branch instance would replace its data copy), then take a snapshot and send a chat turn |
| Costs and proxy | After a streamed chat turn in the agent’s Control UI opened from Rev4a: `GET /api/costs/usage?range=today` shows the candidate's proxy `calls` up, `errors` and `no_usage` unchanged, nothing new under `unknown`. After the daemon's pass: `GET /api/costs/agent?container=<id>` keeps the pre-update days unchanged and prices the new turn (`totalCost` > 0) |
| Sessions | The turn appears in Sessions after the daemon's pass |
| Rules and shared skills | `openclaw skills list --json` in the agent lists the shared folder's skills; a chat turn shows the agent follows the Rev4a rules (`.rev4a/AGENTS.md`). Rev4a's Context page is Rev4a's own model, not proof |
| Cron | `PATCH /api/crons/<jobId> {"containerName":"<id>","enabled":false}` then `true`; runs via `GET /api/crons/runs?containerName=<id>&jobId=<jobId>&limit=5`. Run both seeded jobs on TO with `openclaw cron run <jobId>` (Rev4a has no run-now), before editing them, and wait for a new terminal result. Preserved history or an accepted enqueue does not prove an existing model job still works; check account-binding/adoption requirements |
| Telegram | `PUT …/channels/telegram {"botToken":"<fake>","dmPolicy":"allowlist","allowFrom":["111"]}`, read back (`GET …/channels`), remove (`DELETE …/channels/telegram`) |
| Pairing | `GET …/channels/pairing?channel=telegram`; `DELETE …/channels/pairing?channel=telegram&senderId=0` answers success, not "does not expose its pairing store"; `POST …/channels/pairing {"code":"ZZZZZZZZ"}` reports a failure |
| Devices / Control UI | open the Control UI from Rev4a; the pending browser from step 3 is in `GET …/devices`; approve it there |
| Skills | save a workspace skill (Skills page). Promote only with the owner's ok (Rule 2), under a name of its own (`oc-eval-<card>-…`). `DELETE /api/skills/delete {"skillName":"<name>"}` without `containerName` deletes from the SHARED folder (in full review mode the owner's real one): first check with `GET /api/skills` that `<name>` is exactly the promoted test skill and no skill of the owner's has that name |
| Plugins | `GET /api/plugins?agent=<id>&fresh=1`; external-plugin versions on the volume (snapshot item `file.volume-plugins`) agree with target support; read Doctor's repair/exclusion warnings |
| Credentials | the step 3 credential: `GET /api/credentials/assignments?agent=<id>` shows no error; `GET /api/credentials/detect?agent=<id>` reports it installed |
| Subscription | connected state, a successful turn and `status --usage` survive the update. The owner performs Connect/Cancel through Rev4a when needed; the evaluator never starts a login or generates/relays a device code. Check no login process remains afterwards |
| Lifecycle | Edit (rename and a new port block: `PATCH …`), Recreate (`POST …/recreate`), stop and start (`POST …/lifecycle {"action":"stop"}`, then `"start"`): after each, the model, the Control UI link and a chat turn work |
| Doctor | the update's log: "Doctor warnings", "Doctor changes", "Auto-migrated legacy state"; the `*.bak` files left and their size |
| Rev4a texts | `rev4a-rules/AGENTS.md`, the agent templates, `app/api/assistant/route.ts` and `docs/rag/` still describe TO correctly (tool names, Skill Workshop, heartbeat, cron) |

Finish all functional, memory and recovery cases first, including the previous-Rev4a check in step
12.4. Optional observation runs afterwards, before deleting the last test agent: normally 1-2 hours
agreed with the owner. Record what runs, the instance on :3740, start/end times, health, restarts, OOM,
sessions and unexpected model/proxy activity. Observation does not replace a case test or prove a
particular intermittent fix. Provider incidents, A/B experiments and longer production monitoring
are separate owner-defined work outside this generic checklist.

## 8. Update from the oldest supported version (full track)

Skip only when OLDEST = FROM. On `$OLD`: step 6's snapshot, update, snapshot and compare commands
with `$OLD` for `$CAND` and `--work "$WORK/oldest"` (its own `snap-before`, `snap-after`, `compare.md`,
next to its `seed.json`; `triage.mjs` reads only `$WORK`), then roll it back (step 10's command). After the update no container uses OLDEST's image, so the prune
untags it and the rollback downloads it again: that is the path to prove, the one an install meets
days later. Record the result under "Older agents" in the report.

## 9. Fresh create, memory, startup

1. **Fresh create.** `$FRESH`: `oc-eval-<card>-fresh`, created directly on TO with the `atlas` template
   (it ships `HEARTBEAT.md` and `TOOLS.md`), timed. Stop the candidate first if memory is short.
2. **Startup.** From the first `docker logs -t` line with `[entrypoint] Starting gateway` to the first
   successful `/startupz`: TO on `$FRESH`, against FROM's from step 3.5, on the same host. Create waits
   120 s native, 300 s emulated (`lib/agent-volumes.ts`), and deletes the container and its volume
   when the wait fails.
   Also measure a matched pair of warm starts with the other test agent idle and normal Rev4a
   reads active, when the memory budget permits. Record the exact load; these are not fresh creates.
   Keep this pair as `startupUnderLoadMs` below so a fast empty create cannot hide a slow busy-host boot.
3. **Memory.** The idle memory of the candidate before and after the update is in `compare.md` (both
   snapshots settled); add `docker stats` of `$FRESH` at idle, then while a snapshot runs.
   - An out-of-memory kill does not always show as `OOMKilled`. Read the kernel log:
     `docker run --rm --privileged alpine:3 dmesg | grep -iE "killed process|oom"`. `global_oom` means
     the whole Docker VM ran out: stop.
   - When a kill is reproduced, `GET /api/metrics/alerts?agent=<id>` must show a `container_oom` alert.
4. **Existing agents keep their limit.** An update carries the container's memory limit
   (`rebuildLimitArgs`, `lib/agent-recreate.ts`). Probe the historical2048 MB recommendation explicitly, even when current target admission is higher: `r4 PUT /api/agents/$CAND/memory-limit '{"limitMb":2048}'`, run a snapshot as
   load (`node $S/snapshot.mjs --container $CAND --label load-2048 --work "$WORK"`), and watch `dmesg`
   and `RestartCount` for 30 minutes. On an earlier OOM, stop the load, capture it and restore the
   safe limit immediately; do not create repeated crashes merely to fill the window. If it fails,
   report the minimum tested memory for TO and the Rev4a
   change that protects **existing** agents (not only the picker). Put the limit back to the evaluated target cap (4096 MB for 2026.10.10).
5. **Image size.** `docker image inspect --format '{{.Size}}'` of FROM and TO, for the release notes.
6. **Measured facts for `triage.mjs`.** Write `$WORK/manual.json` with the values measured above (a
   missing key leaves its row `unverified`), then run the final triage:
   ```bash
   cat > "$WORK/manual.json" <<'EOF'
   { "startupMs": { "from": <FROM startup ms>, "to": <TO startup ms> },
     "startupUnderLoadMs": { "from": <FROM busy startup ms>, "to": <TO busy startup ms> },
     "createWaitMs": 120000,
     "dmesgOom": <true when dmesg showed any killed process or oom line during the run, else false> }
   EOF
   node $S/triage.mjs --work "$WORK"
   ```
   `createWaitMs` is 300000 on an emulated host. `--facts <file>` reads another file instead.
   Omit `startupUnderLoadMs` only when that pair was not measured, and explain why in the report.

## 10. Rollback

The candidate has been changed on TO (model, Edit, Recreate, a credential). First take a manual backup
on TO: `r4 POST /api/agents/$CAND/cold-backup`. Then roll back through Rev4a, the Roll back button or
`r4 POST /api/agents/$CAND/update/rollback`, and poll `r4 GET /api/agents/$CAND/update` until
`rolled_back`.
- Offered after `done`, `failed`, `interrupted` or `rollback_failed` while the pre-update backup
  exists (`lib/agent-update-resolution.ts`); refused when this Rev4a no longer lists FROM.
- A rollback restores the pre-update volume and re-applies only credentials, not Rev4a's config
  (`runRollback`, `lib/agent-update.ts`).

Check: the version and the database versions (snapshot item `file.db-versions`); the cron jobs and
the channel as before the update; a chat turn; the model Rev4a shows against `openclaw.json` (a mismatch
after the changes made on TO is a Rev4a fix: re-apply the provider patch after a rollback). Write down
what a rollback loses: volume-local changes made on TO after the backup. Check the exceptions too:
current host-vault credentials are re-delivered, and current container metadata (name/ports/limit)
can remain. Do not promise that every setting returns to its old value.

**Restore across versions.** Restore the TO backup onto the rolled-back FROM candidate
(`r4 POST "/api/agents/$CAND/restore?file=<file>"`) and record what happens: a Gateway that refuses
its database means Rev4a must refuse or warn. Recover by restoring the pre-update backup the same way.
Then the other direction: copy that pre-update backup (FROM data, seed only) into
`<branch data dir>/backups` under `$FRESH`'s name (`agent-$FRESH-cold-<timestamp>.tar.gz`, as in
step 5) and restore it onto `$FRESH` (TO): it must migrate and start.

**Rev4a's own rollback** (§2.2c questions 3 and 5) runs in step 12.4 on `$FRESH`, after the branch
instance is down.

## 11. Report and keep the skill current

1. Write the report from `references/report-template.md`, **in English**, to
   `plans/$CARD-openclaw-$FROM-$TO.md` in the active evaluation worktree (`plans/` is git-ignored), or to
   `$WORK/report.md` when there is no `plans/`. Never commit it.
2. **Independent checker (mandatory).** Give the draft and `$WORK` to one read-only checker sub-agent
   with a fresh context and a strong model. For each Blocker, Rev4a fix and Owner decision it confirms
   the evidence (package file:line, snapshot item, log line, the OLD release's doc for a "new default")
   or marks it unproven. Unproven claims move to "Not proven"; discarded ones are listed with the
   reason. The report goes to the owner only after this pass.
3. Give the owner a short summary in their language, with the report path: the verdict, what was proven
   live, what was only read, what is still running.
4. Keep the skill current in its **own branch and PR** from `main`: the evaluation in
   `references/history.md` (≤ 25 lines; a minor ≤ 5; the heading format and the `**Verdict:**` line its
   header gives, which `triage.mjs` P3 reads: write `go` only when the evaluation ended in go), every
   wrong, missing or moved touchpoint in `references/inventory.md` (and `references/deps.json`), new traps, new script checks. That PR never
   carries the version lines: `git diff main -- agent-templates/base-image/Dockerfile lib/agent-versions.json`
   on its branch prints nothing.
5. For the fix PRs, list: each Rev4a fix with the state already written by the old code and its
   repair (§2.2c); the docs to update (AGENTS.md §2.3, `docs/rag/`, memory-limit texts,
   `app/api/assistant/route.ts`); the release-note lines for every owner decision and behaviour change.
6. Commits and PRs only with the owner's ok (AGENTS.md §2.4): `npm run precheck` first, English only,
   no AI attribution, no host names, local paths or agent ids in PR text. Each fix and side finding is
   proposed to the owner as its own card.

## 12. Clean up, in this order

Everything that needs the branch's database (update rows, backups) is done before the branch instance
stops. The up-front ok covers these steps unless noted.
1. Rollbacks done (steps 5, 8, 10). Switch off the test credential. Remove what the seed made: its
   cron jobs through Rev4a (`DELETE /api/crons/<jobId>?containerName=<id>`, which also tests the
   delete; without `containerName` it answers 400), the fake Telegram channel and the workspace skill
   (start the agent first if it is stopped):
   ```bash
   node $S/seed.mjs --container $CAND --cleanup --work "$WORK"
   ```
   `node $S/park-tag.mjs status` prints "nothing parked".
2. A promoted skill: check it is gone from the shared folder.
3. Delete `$CAND`, `$REH` and `$OLD` through Rev4a (each delete removes its own volume and
   nothing else). Remove their backups and the rehearsal archive from `<branch data dir>/backups`.
4. Stop the branch instance (`review-down.sh`; `review-clean.sh` also trashes the data copy). Restart
   the owner's instance from `main`. **Rev4a's own rollback:** that instance does not list TO; it must
   still list `$FRESH`, stop and start it, and open its Control UI. Then delete `$FRESH` from it.
5. Check the owner's agents against the run log, and `docker images openclaw-agent-base`: download
   again (Agents page) any version their agents need that a prune removed.
6. The local TO image: keep or remove, the owner decides (it is not published). Remove `$WORK` (it holds
   agent data, and the rehearsal's real config); `$REV4A_UPGRADE_WORK/releases` is only the package
   cache. An orphan `agent-*-data` volume from a failed create is deleted only from the System
   page, with the owner's ok (AGENTS.md §2.5).

## 13. From evaluation to users (release gate)

The evaluation tested a local build. Users get a published multi-arch image through a Rev4a release,
on hosts with real data. Each item needs the owner's ok; none is skipped silently. In this order:

1. **Rev4a fixes first.** The blockers' fixes, without the version lines, each with its repair for
   installs already hit (startup or daemon, idempotent, logged), tested on state the unfixed build
   wrote (for example a failed update row with an old baseline). Released to npm before TO is offered,
   so every install can handle TO.
2. **Publish the image.** The Dockerfile ARG reaches `main` in its own PR (the push publishes `:$TO`
   and `:$TO-<sha>`), or the workflow is run by hand (`gh workflow run build-agent-image.yml -f
   version=$TO`). Nothing offers TO yet. A git-checkout install pulls `main` at its next update
   (`bin/rev4a.js`), so `main` never lists a version whose image is not published and checked.
3. **Check the published image**, not the local build. `docker buildx imagetools inspect
   ghcr.io/flame0510/rev4a/openclaw-agent-base:$TO-<sha>` lists `linux/amd64` and `linux/arm64`, with
   the revision and version labels. Run the pinned tag natively on both architectures (amd64 is the
   server class; emulation is not representative for timings): `openclaw --version`, `node --version`,
   a fresh create inside the window (startup under 60 % of the 120 s window on the smallest host class
   supported), one update FROM → TO and one rollback.
4. **Pin and offer.** The `lib/agent-versions.json` entry for TO with `imageRevision` = that sha and
   its `modelInput`; FROM and older versions stay listed while agents run them. Release notes per
   version: every owner decision, the minimum memory, what a rollback loses, the time-delayed effects.
   Then the npm release.
5. **Canary.** With the owner's ok, update one real, non-critical agent first and watch it for the
   agreed days (24-72 h): `dmesg` OOM lines, `RestartCount`, update rows not `done` (`[agent:update]`
   in the Rev4a log), costs and sessions still flowing, channel replies, the motivating failure. The
   owner updates the other agents only after it.
6. **Withdraw plan, written before item 4.** To stop offering TO, remove it from
   `lib/agent-versions.json` in a patch release. Agents already on TO then run an unsupported version:
   they keep running, but cannot be recreated once their image is pruned (`lib/agent-images.ts`), and a
   rollback is refused once their FROM is no longer listed. Write what those operators do, and keep
   FROM listed.

## Minor track

Same Rules, Prerequisites, Setup and failure handling. Every row of `triage.md` (P1-P4, T1-T15) goes
in the report with its result and proof.

| Step | Minor track |
|---|---|
| 0 Scope | kept |
| 1 Static | kept in full: `--notes` and every item (inputs of P4, T1-T5, T7-T11) |
| 2 Image, schema, `rev4a-deps`, first triage | kept; `modelInput` copied from FROM unless T6 |
| 3 Test agents | one candidate on FROM, seeded, its startup recorded |
| 4 Offer TO | kept |
| 5 Rehearsal | dropped; T12 on the candidate's migrated config (step 6) stays |
| 6 Snapshot, update, compare, `rev4a-deps`, `schema-diff --config` | kept in full (T12, T13) |
| 7 Behaviour | the smoke set below, plus every row whose area the static diff or the notes touched; the Subscription row when T11 is `check` |
| 8 Oldest source | dropped when T1 and T10 are `ok` |
| 9 Create, memory, startup, final triage | one fresh create on TO, timed (T15); idle memory from `compare.md` and `docker stats` of the fresh agent (T14); `dmesg`; `manual.json` and the final triage; the old-limit test when T14 is within 10 % of its threshold |
| 10 Rollback | kept, without the restore-across-versions checks: version, database versions, cron jobs, a chat turn |
| 11 Report | the minor report; the checker pass stays |
| 12 Clean up | kept |
| 13 Release gate | kept: published image on both architectures, pin, release order, canary |

**Smoke set:** model change and back; cron disable/enable, then both command and model seed jobs
produce a new successful terminal run on TO; Telegram write, read, delete;
pairing revoke of sender `0` answers success; the Control UI opens from Rev4a;
`GET /api/plugins?agent=<id>&fresh=1`; a chat turn in Sessions and in the proxy metering; the Doctor
lines and `*.bak` files.

**Go for a minor** needs all of: the final `triage.mjs` exit 0 with every row `ok` (or `check` with its
check done) and its proof; the update `done`, with
`compare.md` and `rev4a-deps.md` holding nothing unexplained; the smoke set passed; a fresh create
inside the window, with memory and startup inside T14 and T15; a rollback `rolled_back` with version,
databases and cron jobs as before; the checker's confirmation; the five §2.2c answers. Anything less is
a full-track run or "Not proven". Shipping a minor is the version lines with the published, pinned
image, through step 13.

## When something fails

"Stop" means: stop the test agents when that is safe, leave everything else as it is (no clean-up, no
restart), write the state in the run log, and tell the owner.

Check observation deadlines and long gaps before acting on a final response; never automatically
chain a late `failed` result into rollback. Host sleep is an environment invalidation, not proof of
an OpenClaw defect. Save power and runtime evidence and fix the prerequisite before independent
remaining cases. A failed rollback is not retried; preserve its row and backup. Do not count a
suspended-host observation as completed time.

| Situation | Do |
|---|---|
| An agent that is not a test agent restarted, changed version or was OOM-killed (`dmesg`) | Stop the test agents. Stop. |
| `global_oom` in `dmesg` | Stop the test agents. Stop. |
| The memory formula fails for the next step | Do not start the agent. Stop. |
| Free disk under 5 GB | Stop. |
| An update in `backing_up` more than 10 min on a small test agent, or in `migrating`/`verifying` past 10 min (Rev4a notes "still starting after 10 minutes") | Read `docker logs -t --since 15m <agent>` and the Rev4a log. Never restart Rev4a or the agent (Rule 10). Stop. |
| A rollback ends `rollback_failed` | No retry, no delete. Save `GET /api/agents/<id>/update`, the agent's logs and the backups folder listing. It is a blocker in Rev4a, not in TO. Stop. |
| A step needs a fleet action, a shared skill, a publish, a server, a commit or a push | Ask the owner. |
| The evidence for a blocker cannot be produced after one retry | Stop and report what is missing. |
| `snapshot.mjs` exits 2 | Read `index.md`: preflight (agent down, Gateway not started, wrong `REV4A_BASE_URL` or secret) or too many failed items. Fix the cause, wait 2 min, take it again with `--force`. A finding only when it fails twice. |
| An item fails in one snapshot | `snapshot.mjs` already retried it once; `compare.md` lists it. A finding when it also fails in a retaken snapshot. |
| Another script exits 2 | No trustworthy output: `compare.mjs` (a snapshot not fit, see above), `schema-diff.mjs`/`rev4a-deps.mjs` (a schema not readable: is the image local?), `triage.mjs` (a static input missing), `release-diff.mjs` (no release body found), `neutralize-backup.mjs` (archive not handled: stop). |
| A tag is still parked (`park-tag.mjs status`) | `node $S/park-tag.mjs restore --all` before any other Rev4a action. |
| A create fails, or the session stops, while a tag is parked | Restore first (`node $S/park-tag.mjs restore --all`, then `status` prints "nothing parked"); only then read the failure or retry the create. |
| The branch Rev4a crashes or exits during an update or a rollback | Touch nothing (never the agent, Rule 10). Save the Rev4a log, `docker logs -t --since 30m <agent>` and `docker ps -a` for that agent. With the owner's ok, start the branch instance again on the same data: at startup `recoverInterruptedUpdates` (`instrumentation.ts`) marks the row `interrupted`; read `GET /api/agents/<id>/update` and record what state the agent was left in (image, version, running or not). Whatever it is, it is a finding about Rev4a. Stop. |
| The owner's instance does not come back at clean-up (step 12.4) | Nothing else first: no agent delete, no image prune. Read its log (`journalctl -u rev4a` or the terminal it ran in), check `REV4A_DATA_DIR` points at the owner's data and not the branch copy, and that :3740 is free (`review-down.sh` done). Tell the owner at once. |
| A test agent's delete fails, or leaves its `agent-<id>-data` volume | Retry the delete once through Rev4a. Never `docker volume rm` by hand (AGENTS.md §2.5): the volume is listed on the System page as an orphan and deleted from there with the owner's ok. Write it in the run log. |
| An owner's agent needs an image a prune removed (`pruneAgentImages`, `lib/agent-images.ts`) | Do not recreate or update that agent. Download the version again from the Agents page (or `r4 POST /api/agents/download-image`) and check `docker images openclaw-agent-base` lists it; tell the owner. |
| A create times out | Check memory first (`dmesg`): under pressure it is not a finding about TO. Rev4a already removed the half-made agent; retry once with fewer agents running. |
| A test agent cannot be recovered | Delete it (up-front ok), recreate it, take its before-snapshot again. |
| The owner is unavailable for Connect | Go on; Subscription goes in "Not proven"; keep `$FRESH` stopped for them. |
| The branch build fails | A branch problem, not TO: fix it or stop. |
| `npm` or `gh` fails (`release-diff.mjs` exit 1) | Retry once; without `gh`, run without `--notes`, read the notes on GitHub and say so (T10 stays `unverified`: the full track). |

## Using sub-agents

May run in parallel, read-only (no Docker, no Rev4a writes), each given `$WORK`, the inventory and this
file:
- **release reader**: every release body between FROM and TO, as a table by inventory area with the
  release and the quote; timers and counters marked;
- **diff reader**: each item of `release-diff.md`, `schema-diff.md` and `rev4a-deps.md` against the
  inventory rows, with `git grep` for retired paths;
- **fix tracer**: the motivating fix in the TO package (core or plugin, APIs FROM lacks);
- **inventory refresh**: every file:line in `references/inventory.md` still points at its touchpoint
  on `main`; drifted rows listed;
- **checker** (mandatory, step 11.2): a fresh context and a strong model, after the draft report.

Never in a sub-agent and never two at a time: anything that runs `docker`, a Rev4a write, or a script
other than `release-diff.mjs` and `triage.mjs`. One Docker, one Rev4a, one memory budget: the
coordinator runs them in order. Sub-agents work in English; a cheaper model reads, a stronger one checks.
