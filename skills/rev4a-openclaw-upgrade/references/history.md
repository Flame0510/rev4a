# Evaluations and traps

This file is the skill's evidence log, read by the next evaluation; it is not product documentation.
Newest first. Each evaluation records what it found and what it taught (≤ 25 lines; a minor-track run
≤ 5); the evidence lives in the evaluation's report. The traps at the end apply to every evaluation and
are the part to keep current: each names the code that makes it true, so it can be re-checked.

Headings: `## <FROM> → <TO> (<card>, <date>)` for a full evaluation, `## <FROM> → <TO> (minor, <card>,
<date>)` for a minor one: keep the arrow, the full target version and the word `minor` exactly so.
Every entry has one verdict line of its own, `**Verdict:** go` when the evaluation ended in go (the
release was offered to users), otherwise `**Verdict:** no-go` or `**Verdict:** pending`, with the
reason after it. `triage.mjs` (P3) allows the minor track on a line only when a full (not minor)
entry for that line has the line `**Verdict:** go`; a minor entry never opens the track. Write `go`
only after the release gate (SKILL.md step 13) is passed.

## 2026.9.9 → 2026.10.10 (OC-10, 2026-11-07)

**Scope:** local acceptance of the fix branch with real channels and a release rehearsal.
Measured by the orchestrator on 2026-11-06/07, Docker Desktop on an arm64 Mac.

- A real Telegram bot and ChatGPT sign-in on 9.9 reproduced the cron's 403 owner-verification error.
  After Update to 10.10, two crons were associated with the single connected account automatically;
  the cron delivered without 403. Pairing, Crons page and Control UI worked. Rollback to 9.9 worked
  and the agent answered.
- One paid-provider turn through `rev4a/deepseek/deepseek-flash` on 10.10 wrote a `proxy_usage_hourly`
  row for the right agent, with tokens and cost. This closes the 2026-11-06 entry's unproven proxy
  metering and real Telegram pairing items.
- Published-image simulation: a multi-arch build pushed to `localhost:5555`, with
  `REV4A_AGENT_IMAGE_REGISTRY` set; `rev4a serve` preflight pulled it, blocking the dashboard for
  about 4.5 minutes (known behaviour). Update from that image completed; this did not test the pin.
- Release rehearsal: npm 1.22.0 installed into a sandbox prefix with a copy of the data directory;
  a 9.9 agent was created, then the branch's `npm pack` tarball installed over it (postinstall built
  `.next`). First start took 5 s and startup sync was clean; Update 9.9 → 10.10 finished in 91 s,
  verification ok and the retired cron accepted.
- Graceful stop on 10.10 with `docker stop -t 400`: idle 6 s (exit 0, "completed cleanly"), during
  startup 1 s (exit 143), right after a turn was sent 16 s (exit 0). The cold backup's 30 s stop
  (`lib/cold-backup.ts`) is enough in normal use; an earlier forced stop occurred only at ~300 % CPU.
  No change was made.

**Verdict:** pending (local acceptance passed; the published ghcr multi-arch image, the pin and the VPS test are not done yet).

## 2026.9.9 → 2026.10.10 (OC-10, 2026-11-06)

**Scope:** fresh full-track local evaluation and first live run of the v2 helper scripts.
- Seeded 9.9, neutralized real data and oldest supported 9.3 all migrate but fail Rev4a's
  name-only cron verification on the retired OpenClaw-owned collection review; counted events survive.
- The 2048 MiB recommendation fails under Rev4a reads: memcg kills the Gateway within seven seconds,
  despite `OOMKilled: false`. 3072 MiB passes basic cases but later OOMs during CLI config/model checks;
  the remaining case passes at 4096 MiB. The new admission floor is 4096 MiB, not a universal guarantee.
- Full-volume rollback works for 9.9, real data and 9.3; the latter downloads its pruned image again.
  TO-only files/model changes revert; current host-vault credentials are re-delivered.
- A TO backup restored onto FROM is accepted and marked done while the Gateway refuses newer schemas.
  Restore needs compatibility preflight and actual Gateway readiness, plus repair of false-success rows.
- An older model job using a stored sign-in fails on TO until explicit account adoption;
  old successful history is no proof. Fresh create and other bounded behaviour checks pass.
  Positive paid-provider proxy metering, real Telegram pairing and non-empty retired proposals remain unproven.
- Workshop approval/history retirement and delayed learning cleanup require explicit release decisions;
  automatic learning was already the old default. Pairing's internal sync API expires after 2026-12-31.
- A repeated audit/rollback was invalidated by laptop hibernation; preserve its failed row and backup,
  without retry. Its warming-cache totals are not valid migration-cost comparisons.
- Helper fixes cover release-note completeness, snapshot/cron evidence, archive safety, warming caches,
  observation gaps and preserving seed evidence during cleanup; each has regression coverage.
- Provider-specific incident reproductions and long soaks are outside this generic evaluation.
- Busy-host warm starts take 139.1s on FROM and 175.7s on TO despite a 12.9s idle fresh TO start.
  T15 checks both measured pairs; these observations are not native published-server timings.

**Verdict:** no-go (local implementation acceptance passes; owner decisions and the published multi-architecture gate remain open).

## 2026.9.9 → 2026.10.10 (OC-10, 2026-11-04)

**Scope:** a full evaluation of the new OpenClaw line and Rev4a compatibility.

Found, local Docker, through Rev4a:
- **Blocker: Rev4a's Update failed on every agent.** 10.x deletes the OpenClaw-owned cron job
  `skill-collection-review-main` (declaration key prefix `skill-collection-review:`,
  `RETIRED_SKILL_COLLECTION_REVIEW_DECLARATION_PREFIX`). `lib/agent-update.ts` compares every job by
  name, so the verification reported "Cron jobs missing after the update". Everything else had
  migrated: no lost events, user jobs intact, agent DB schema 24 → 27.
- **Blocker: 2 GB is not enough.** The 10.10 Gateway idles at ~1.4-1.5 GB (9.9: ~1.0-1.3 GB). With a
  2 GB limit, the `openclaw` CLI processes Rev4a runs inside the agent push it over, and the kernel
  kills the Gateway (seen in `dmesg`, `OOMKilled` false). Rev4a calls 2 GB "comfortable"
  (`app/components/ui/MemoryLimitPicker.tsx`).
- **Owner decision: Skill Workshop approval is gone.** 9.9's default was already `autonomous.mode:
  "auto"` with `approvalPolicy: "auto"` (agents edit their own skills); what 10.x removes is the
  option to require approval (`"propose"`, `approvalPolicy: "pending"`, `maxPending`). The weekly
  collection review is replaced by a background review after 10 iterations and by archiving learned
  skills unused for 30 days (Codex-runtime agents excluded). Pending proposals are exported, not
  loaded. A first reading said "approval was the default in 9.9": wrong, caught by `release-diff.mjs`.
- **Deadline:** `readChannelAllowFromStoreSync`, used by the pairing store script in
  `lib/channelManager.ts`, is `@deprecated … final compatibility day: 2026-12-31`.
- Node: 10.6-10.9 refuse to start below Node 24.22.1; 10.10 only warns. The image now fails its build
  on an older Node.
- Startup: 9.9 ~45 s, 10.10 46-68 s, 114 s under memory pressure (create waits 120 s).
- Unchanged for Rev4a: every JSON field Rev4a reads, channels and Telegram write/delete, pairing read,
  devices, cron toggle and runs, model change, skills, plugins (+5 bundled, none removed), memory
  context, costs, sessions, credentials detect, a fresh create on 10.10 (134 s), the real migrated
  config validates on 10.10, and Rev4a's Roll back (42 s; DB back to v24, the retired job back).
- Doctor leaves `*.pre-startup-migration-*.bak` copies of the state and agent databases (3 MB and
  0.7 MB on a small agent; proportional to the databases on a large one).
- Side findings in Rev4a, not caused by 10.10: `app/api/skills/save/route.js` guards the wrong bundled
  skills path (`/usr/lib/…` instead of `/usr/local/lib/…`); `/api/agents/config-json` masks only the
  gateway token (bot token and provider key reach the browser); `approvePairing` counts any output
  without the word "error" as success; Sync All deletes `models.json` and `auth-profiles.json` blindly;
  `agents.list` is in neither the 9.9 nor the 10.10 schema (`agents` = `ownership, defaults, entries`,
  no other key; `rev4a-deps.mjs`: KW6 "missing in FROM and TO"), yet the model panel writes it
  (`app/api/gateway/agent/route.ts:165-178`), subscriptions read and write it
  (`lib/subscriptions.ts:511-573`) and Codex detection reads it (`lib/credentials/runtime.ts:26`), while
  nothing reads `agents.entries.main.model` (inventory KR2, KR13, KW6). Read from the schemas, not
  reproduced on a live agent.

**Verdict:** pending (the two blockers above are open in Rev4a; until a full 10.x evaluation
records `go`, `triage.mjs` P3 keeps every 10.x release on the full track)

## Traps

- **A registry override disables the pin.**
  `pinnedRevision()` in `lib/image-revision.js` returns null when `REV4A_AGENT_IMAGE_REGISTRY` is set,
  by design. A local-registry simulation never exercises the pinned-pull path; check that path
  against the real ghcr image after publishing.

- **The doctor's codex plugin reinstall can fail once and repair itself.**
  On first start of 10.10, `doctor --fix` (`agent-templates/base-image/entrypoint.sh`) reinstalled
  the plugin in `~/.openclaw/npm/projects/`; missing `@openai/codex-linux-arm64` broke one run.
  Migration took ~10 minutes instead of ~3; the Gateway repaired it on its next start.
  `scripts/snapshot.mjs`'s `file.volume-plugins` now lists the `@openai/codex*` packages next to
  `@openclaw/*`, so a missing platform package shows in the diff. A slow first start is not a failure by itself.

- **A loaded host can push a FROM create past the create wait.**
  With another agent at ~300 % CPU, two 9.9 creates exceeded `NATIVE_READY_TIMEOUT_MS` (120 s,
  `lib/agent-volumes.ts`); `app/api/agents/create/route.ts` cleaned them up correctly.
  Stop other agents before timing creates; record the load with the number.

- **Fast empty startup does not clear busy-host startup.** A fresh empty TO agent started in 12.9s,
  but a restored/connected agent took 175.7s with another agent and normal Rev4a reads.
  Keep matched idle and busy pairs with their exact conditions. T15 now evaluates optional
  `startupUnderLoadMs` too; a regression ensures the fast pair cannot hide the slow one.

- **Preserved cron history is not a working automation.** An agent-turn job that succeeded
  on FROM failed twice on TO with `Automation has no recorded inference account`; its old
  success and usage were still visible. Run the existing model job on TO before any edit,
  await its new terminal result, and record explicit account adoption separately. Doctor
  must not guess historical account ownership. Command-only jobs cannot exercise this path.

- **Cleanup must preserve the seed evidence.** The original cleanup overwrote `seed.json`,
  erasing which fields were exercised. It now writes `seed-cleanup.json`; a real script run
  against fake Docker and a loopback API checks that the original record survives.

- **Restore success is not Gateway readiness.** Rev4a can mark an extraction `done` while
  an older Gateway refuses newer database schemas. Check `/startupz` and the actual schema
  error separately, then recover with the pre-update archive. Never infer usability from
  `startAndVerifyContainer`, which checks only running state and network attachment.

- **A rebuilding usage cache can return zero successfully.** The real-data audit returned
  zero with40 pending/stale files on FROM, then populated totals with a fresh cache on TO.
  Those are not comparable baselines. Snapshot usage RPCs now reject explicit non-fresh caches
  and retry; a regression covers the observed shape. Do not call cache warming migration drift.

- **Fresh-create load probes are not seeded.** A missing evaluator workspace skill is optional
  on a demonstrably unseeded fresh agent, not a compatibility failure. A successful seed record
  for that agent still makes its disappearance a failure; a failed skills listing never proves
  absence. The live fresh probe exposed this distinction; regressions cover all three states.

- **Host sleep can create false migration and rollback failures.** A laptop at1% battery
  hibernated during both operations; after wake, the old Gateway became ready but its readiness
  window had expired. Keep AC power/sleep prevention and retain power logs. Check observation
  gaps/deadlines before final-status handling: the private watcher once chained a late failure
  into rollback. Regression fixtures replay the real gap and late-final timing; no blind retry.

- **A healthy Gateway can still have a cached Costs error.** Costs are collected every300s
  (`lib/agent-costs.ts`, `COLLECT_INTERVAL_S`); a downtime failure remains in the API until the
  next pass. The first oldest-source after-snapshot failed that item, but a full retake after
  waiting passed. Keep the first evidence; do not suppress the error or call it migration loss.
- **Codex private databases do not use OpenClaw schema markers.** Their `user_version` can
  stay0 while `_sqlx_migrations` and tables change. The9.3 path replaced `thread_artifacts` with
  `thread_attachments` in codex-home/state_5.sqlite; table-name changes alone prove neither
  data loss nor attachment preservation. Full-volume rollback must include those files too.

- **Agent cron usage is in the agent-run snapshot item.** J5's usage/model/session fields must
  read `cli.cron-runs-agent`, not the separate command-only `cli.cron-runs`. The live seed had
  populated them, but the old dependency mapping still called them unexercised. A fixture with
  both distinct run shapes protects the mapping.

- **Pending browser requests expire in five minutes.** Both 9.9 and 10.10 use a 300000 ms TTL.
  The step-3 request expires during rehearsal and snapshots. Refresh it immediately before the
  update and check/approve immediately afterwards; classify that approval in the comparison.
  A long update can still expire it: a new request from the same browser proves TO approval,
  not migration persistence of the old pending request.

- **Unknown measurements cannot certify a settled snapshot.** Failed/malformed Docker CPU reads
  stay unknown; uptime is refreshed after every inspection so a restarted container settles again.
  Nested database read errors fail their item. Regression fixtures cover each case.
- **Force must preserve evidence when inspection fails.** A missing or unavailable agent is
  refused before clearing a previous snapshot, even with `--force`; the fake-Docker test verifies it.
- **Archive metadata controls extraction paths.** The neutralizer refuses PAX headers instead of
  copying extraction paths it cannot interpret; short headers/bodies and missing end markers fail
  with no output. Fixtures test PAX credential paths and gzip-valid truncated tar archives.

- **A local Control UI browser may be silently approved.** Container-private peers with a
  loopback browser origin and token authentication qualify for local auto-approval. To seed a
  genuine pending browser on the test candidate, set the supported test-only
  `gateway.nodes.pairing.autoApproveLocal: false` before opening a fresh browser profile, keep
  it through the update, then approve from Rev4a. A fresh profile alone does not prove pending.

- **Browser navigation errors include the token fragment.** Wait for Gateway readiness before
  opening a plain-token Control UI link, and catch/redact browser exceptions before logging;
  an uncaught Playwright error can print the complete URL. A regression tests that exact error
  shape against `redact()`. A new agent may have no `.agent-token` file: use its existing
  `OPENCLAW_GATEWAY_TOKEN` fallback privately, as Rev4a does; never print either value.
- **A seeded cron session is not a successful model turn.** The first live v2 seed counted a
  run with `status:error`, `completionStatus:failed` and a billing error as OK because it had a
  `sessionId`. `seed.mjs` now compares previous run identities and checks the new terminal run's
  success/error fields; stale sessions and explicit failures cannot pass. The regression suite
  covers the real failure shape. Seed step details are redacted before logging or recording.
- **A copied lifecycle database can resume an interrupted restore.** Startup recovery
  (`lib/agent-restore.ts:133-142`) can clear and re-extract an agent's volume, not merely restart it.
  Inspect pending operations before serving a data copy; never point another instance at an
  agent someone uses without the owner's explicit authorization for its automatic effects.
- **Docker CLI and API isolation must agree.** Rev4a's API resolver accepts Unix sockets only,
  then falls back to the context and local sockets (`lib/docker-socket-path.js:33-38,79-85`). A
  TCP/SSH CLI target or unavailable isolated socket can leave API calls on the owner's Docker.
  Verify the resolved Unix socket in fresh processes; successful resolution is cached for life.
- **A refused snapshot destination needs no Docker call.** The non-empty-directory check used to
  follow `inspectAgent`; even the offline suite then waited on a starting Docker daemon. Refuse
  before inspection, but retain the owner-agent guard before any forced deletion or snapshot write.
  A fake Docker invocation marker tests this ordering.
- **GitHub release bodies can be publication wrappers.** `openclaw-release-publication:docs-v1`
  links to substantive notes elsewhere. `release-diff.mjs --notes` now resolves the changelog
  through GitHub at the release tag, preserves the wrapper separately, and reads the complete
  paginated release list rather than silently cutting it off at 200. An empty selected release
  body or a missing linked file fails instead of claiming that the notes were checked.
- **Older gh versions lack release-list JSON flags.** `gh 2.35.0` rejects `release list --json`.
  `release-diff.mjs --notes` now uses GitHub REST release-list pages through `gh api`, keeping
  the bodies (including hotfixes) and rejecting failed or malformed reads. The script suite tests
  pagination and failures with a fake gh; the live evaluation checks the installed gh as well.
- **The suggested home work folder can be inside a Git tree.** A dotfiles repository at `$HOME/.git`
  makes every path below home fail `assertOutsideGit` (`scripts/lib.mjs`). Pick a persistent disk
  directory outside that tree; do not disable the refusal. Keep the same base for the whole run.
- **A silent child-process timeout still needs a diagnostic.** `execFileSync` returns an empty
  `stderr` string on a silent timeout; treating it as a useful message left `release-diff.mjs`'s
  npm failure ending at a blank colon. `run()` now reports the command and deadline in that case;
  the regression suite exercises an actual timed-out process.
- **Release notes are summaries.** 10.x declared no breaking change; the update-breaking retirement
  is one line in a docs page. Read the docs diff (`release-diff.mjs`) and the code.
- **Check the old default before you claim a new one.** Compare both releases' docs for the same key.
- **OpenClaw owns some cron jobs.** Jobs with a `declarationKey` (`heartbeat:`, `memory-core:`,
  `skill-collection-review:` …) are created and retired by OpenClaw. Any Rev4a comparison of jobs
  must tell them apart from the user's.
- **Plugins on the volume do not follow the image.** The codex plugin is installed under
  `~/.openclaw/npm/projects/`. A new image does not replace it; the new release's doctor may. Check its
  version inside the agent after an update.
- **Memory limits produce false findings.** Use the evaluated target cap (4 GB for10.10), and one
  agent when two caps plus headroom do not fit. A later CLI config/model sequence exhausted3 GB
  after basic migration cases had passed. A restarted container can show `OOMKilled: false` and
  reset cgroup counters: retain the live Docker OOM stream/anomaly log as well as samples and `dmesg`.
- **The Mac's Docker VM is shared.** Two test agents with 3 GB limits, the owner's agents and
  Rev4a's own CLI calls (the daemon and open pages run `openclaw` in every agent; each start costs
  ~1 CPU-second and 100-250 MB) exhausted a 7.6 GB VM. The kernel then killed the Gateway of one of
  the owner's agents (it restarted by itself). Run at most one or two test agents at a time, stop
  them between steps, take snapshots one at a time, and ask the owner before running more agents
  next to theirs.
- **A Gateway that just started is not settled.** Right after `/startupz` answers, `openclaw
  dashboard --json` timed out on 10.10 and worked a minute later. `snapshot.mjs` now waits for
  `--settle` seconds of uptime and a calm CPU, and retries a failed item once; a failure in one
  snapshot is still not a finding until a retaken snapshot repeats it.
- **Create picks the newest local version Rev4a lists**, not the newest image
  (`newestLocalSupportedVersion`, `lib/agent-images.ts`). Create FROM agents before the branch lists
  TO; park a tag (`park-tag.mjs`) only for a version older than FROM.
- **A successful update prunes agent images.** `pruneAgentImages` (`lib/agent-images.ts`, run at the end
  of `runUpdate`) untags every agent image no container uses that is not one of the two newest
  versions. An older version then has to be downloaded again for a rollback or a create.
- **The branch's Rev4a writes to every agent at startup, stopped ones included.** `instrumentation.ts`
  runs Sync All (inventory FL1): it lists agents with `docker ps -a` and writes `openclaw.json` into
  stopped ones with `docker cp`; only the `rm` of `models.json` and `auth-profiles.json` skips them
  (`app/api/gateway/sync.ts`). The price-band re-sync (FL2) follows every minute. Stopping the owner's
  agents does not protect them: the branch may serve their host only when it does not change that code.
- **A Rev4a whose first listed version is missing pulls it at `rev4a serve`**, and builds it locally
  when the pull fails, before the dashboard starts (`ensureAgentImage`, `bin/rev4a.js`). Build the TO
  image before starting a branch that lists TO.
- **Re-copying the data directory loses the update rows.** The update row, which a rollback needs
  (`runRollbackStart`, `lib/agent-update.ts`), lives in the instance's database; the backups folder is
  not part of that copy. The maintainer's `review-up.sh` takes a fresh copy at every start: never
  restart it between an update and its rollback.
- **A restart of Rev4a during an update marks it `interrupted`** (`recoverInterruptedUpdates`, called
  from `instrumentation.ts`) and restarts nothing for you. Wait, read the logs, never restart.
- **Update refuses a stopped agent** (`runUpdateStart`): start the candidate after the stop between
  steps.
- **A restore starts the agent as soon as the archive is extracted** (`lib/agent-restore.ts`). A copy
  of real data must be neutralized before the restore (`neutralize-backup.mjs`: channels,
  `cron.enabled: false`, secrets, sign-ins, credential files, `.agent-token`), and its file name must
  carry the target agent's id (`isValidBackupFile`, `lib/backups.ts`). It keeps transcripts and memory:
  personal data stays in the copy.
- **A rollback does not re-apply Rev4a's config**, only credentials (`runRollback`), and is refused once
  the Rev4a running it no longer lists FROM.
- **An update carries the container's memory limit** (`rebuildLimitArgs`, `lib/agent-recreate.ts`). A
  higher recommendation in the picker protects only new agents.
- **A create that misses its readiness window deletes the container and its volume**
  (`app/api/agents/create/route.ts`): a slow first boot on a small host is a lost create, not a slow one.
- **A pre-update backup needs free space for 60 % of the volume** in the backups folder
  (`lib/cold-backup.ts`); the doctor's `*.bak` copies stay on the volume and go into every later backup.
- **A hotfix `-N` is its own release.** `release-diff.mjs --notes` once compared three version parts and
  left a `-N` release body out; check that a `-N` TO's own notes were saved. Rev4a's
  `compareVersions` (`lib/agent-versions.ts`) treats `-N` as a fourth part.
- **`main` reaches git-checkout installs before any npm release.** Their update runs `git pull` on the
  current `main` (`bin/rev4a.js`), so version lines on `main` are offered to them at once.
- **A pull, tag and push of a multi-arch tag publishes one platform.** Retag with
  `docker buildx imagetools create` (CONTRIBUTING.md, Agent image publishing).
- **macOS has no `timeout`.** Use the commands' own `--timeout` or Node's.
- **`docker exec` exits 0 when the command was killed by an in-container timeout.** Look for the
  expected output, not the exit code.
- **One Rev4a per Docker.** The branch instance on :3740 replaces the owner's instance; restore it.
- **Moving a dependency loader also changes offline repository fixtures.** Pairing moved from
  `channelManager.ts` to `channel-pairing-store.js`. Update `deps.json` evidence/name patterns and
  copy the declared loader into unrelated fake-repository tests; otherwise the C4 classifier
  fails on missing internal names before it reaches the behavior being tested. The existing
  C4 regression and dependency-evidence regression cover the moved loader.
- **A bundler module ID is not a subprocess module path.** Next.js rewrote a bare
  `require.resolve('better-sqlite3')` into a numeric ID in the new backup inspector. Source
  tests passed, but the compiled Restore refused every archive during safe preflight.
  Resolve with Node's `createRequire` from the application's package working directory,
  which `rev4a serve` sets explicitly. Test both the bundler-shaped resolver and the
  actual compiled Restore before treating source-level SQLite checks as acceptance.
- **A fast stop/start can hit Rev4a's lifecycle cooldown.** The lifecycle route refuses a
  second action within three seconds with HTTP 429. A private live-test harness stopped its
  agent successfully, then mistook that intended refusal for a runtime failure. Respect the
  cooldown before Start and record each response immediately; an assertion after the pair
  otherwise loses the successful Stop evidence.

- **Never use a predictable `.partial` archive path.** It can be the input itself, a symbolic link,
  or a hard link. Neutralization now creates a unique temporary output with O_EXCL, checks
  realpath and device/inode aliases before writing/publishing, and cleans up only its own inode.
  Input bytes and pre-existing partial paths must survive both success and failure.
- **Failure indexes are secret-bearing output too.** Redact snapshot stdout/stderr, validator
  failures, `jsonProblem`, retry logs and index JSON/Markdown before storing or printing them.
  Redact JSON tokens by exact secret key, regardless of value length or type;
  text containing JSON needs escape-aware quotes. Short passwords and escaped quote suffixes
  must be included in the script regression fixtures.
  Callback-thrown UsageError messages need the same redaction. Token scanning must be bounded:
  64 KiB of unmatched opening brackets must finish within 200 ms, without rescanning each suffix.
  Key scanning must reconsider a closing diagnostic quote as a possible secret-key opening:
  an unmatched prefix quote can otherwise consume `"token"` and leak an object/array value.
  This also applies when an escaped prefix string was itself redacted. Tests cover string,
  numeric, object and array secrets after unmatched quotes and the 64 KiB timing budget.
- **Adopt inference accounts without pinning Default jobs.** In 10.10 a native model/profile
  update captures the private binding; clearing the model retains it. Public cron responses hide
  the binding. Inspect safe metadata read-only, preserve existing bindings, use revision guards,
  and verify both primary-model and fallback inheritance after adoption.
  Commit the original model in Rev4a's DB before temporary selection. A committed native mutation
  can lose its response; later passes and startup must reconcile the recorded pin with fresh
  revision/account checks before treating a bound job as finished.
  The adoption journal is scoped by agent, update ID and job ID so restored pre-update jobs
  are adopted again after rollback. OpenClaw's `captureCronUpdatedInferenceBinding` skips a
  new binding on CLI-execution routes; exact journaled pins must still be undone after a
  commit-then-reject response, without requiring a binding or overwriting operator changes.
