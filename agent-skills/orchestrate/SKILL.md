---
name: orchestrate
description: Work through a project's backlog with sub-agents, one small task at a time. Scripts pick the next task from the tracker, make a git worktree, run the gate and keep all state; a worker sub-agent writes the change, an independent checker sub-agent tries to break it, and the merge happens only on the owner's explicit ok. Use for "orchestrate", "run the backlog", "next task", "worker", "checker", "split this task".
---

# Orchestrate (v0)

You are the **coordinator**. You do not write the code and you do not keep the books: the `orch` script does the
mechanics and holds the state, a **worker** sub-agent writes the change, a **checker** sub-agent checks it, the
**owner** approves the merge. Every `orch` command prints a few lines ending in `next: …`. Do that next.

    ORCH="node <this skill's folder>/scripts/orch.mjs"     # run it from the project folder

## Rules
1. **One task = one small mergeable change.** If a task owns most of the repository, or cannot pass in one round,
   split it before starting (see "Splitting"). `orch next` refuses tasks that are too broad.
2. **The script keeps the state.** Never write ledgers, report.json, history, inventories or line counts. Never
   edit `.orchestrate/runs/`. To know where you are: `$ORCH status`.
3. **Judge code, not paperwork.** The gate counts files and lines; the checker judges the code and must quote
   `EXECUTED:` evidence. Never send work back because a report is worded badly.
4. **At most `limits.correctionRounds` correction rounds** (`orch config` shows them). Then stop and decide with
   the owner: accept (only after a gate PASS), split, or park — or, when the owner set `limits.atRoundLimit` to
   `coordinator`, decide yourself as "When it does not converge" says.
5. **Merge only with the owner's consent**: their explicit ok for this task (`finish --approved-by <name>`), or a
   standing approval they gave for this project (`orch config` shows it; then `finish <id>` alone). Only the owner
   grants or revokes it (`$ORCH config --standing-approval <name>` / `--owner-approval`), never you on your own.
   A protected branch (main, master, production) always needs the per-task ok, and accepting work without a
   checker PASS (`--override`) always needs it too.
6. **One coordinator.** Do not start a second coordinator, a watchdog or a cron job. Sub-agents announce when
   they finish: wait for that, do not poll.
7. **Keep your context small.** Do not read diffs, logs or prompt files in full: the gate line tells you what
   failed; open a log tail only if you must explain it to the owner.
8. **Do not change this skill.** It belongs to Rev4a and is replaced on update. A lesson goes to the owner as a
   proposal, not into a new local rule. The project's own settings live in `.orchestrate/config.json`.
9. **A card that lacks files gets them, without losing a round.** When the worker reports it cannot finish inside
   the card's files (it names them), or the gate fails only on scope, add exactly the files needed with
   `$ORCH card normalise <id> --from <card.json>` (the card's rules still apply), then `$ORCH fix <id>`: the fix
   brief names the new files, and that round does not count toward the limit (once per run).
   On a scope failure, choose to own exactly those files with normalise, or use `$ORCH fix <id> --scope revert` to have the worker restore them to the base in a counted round, fixing any other failures too.
   If the next round fails on any of the same outside files (or either gate list is partial), plain fix refuses (exit 3) until normalise covers the scope violation or you choose revert with a counted round left; partial lists are examples, so own or revert every outside file, or split or park.
10. **The config is the owner's.** Never change it (`config --set`, editing the file) and never `config --confirm`
   it on your own, not even under a broad autonomy mandate or to undo a change you remember making: propose the
   change to the owner and wait for their ok. A limit raised for one task stays as the owner leaves it. The campaign
   keeper reports every config change to the owner.
11. **A report is only ever the sub-agent's own.** A completion is this sub-agent's only when its label (or
   taskName) is exactly the one the `next:` line gave; completions of other batches are not it. Never write a report
   in a sub-agent's place, not even a placeholder: during a campaign `record` refuses while the runtime shows that sub-agent running (at most for its time limit). A
   sub-agent that ended without a report and without an answer is started again with the same brief, in the same
   round. `orch status` shows a LATE REPORT (a checker report nobody recorded: it came after its round was closed,
   or after another checker's FAIL): its findings go to the worker (`sessions_send` if one is running; the next `orch fix` brief carries them anyway).
   During a campaign, `gate` and `fix` also refuse while the runtime shows the worker running (exit 4, no round used,
   at most for its time limit); `fix` checks workers of every round. The `next:` line then says to wait. Without
   runtime information these commands behave as before; `record` keeps its existing refusal and exit code.
12. **Nobody changes a worktree after its gate.** When `record` or `finish` says the worktree changed after the gate,
   look at what changed (the message says): if nobody meant it (a sub-agent's "undo"), `$ORCH restore <id>` puts back
   what the gate passed, keeps a copy of what it replaced, and the recorded verdicts stay; then record again. Run
   `$ORCH gate <id>` again only for a change that is wanted.

## Setup (once per project)
1. `$ORCH init` reads the tracker, the check command (`npm run check` if it exists), the base branch and the
   models this agent has, and proposes roles: a cheaper **worker**, a different, stronger **checker** (with one
   model, the checker is the same model in a fresh session).
   It also finds the test **harnesses** (Playwright, Cypress): the gate runs a harness when a change touches the
   paths it covers. It lists the other test scripts and the CI workflows it saw without adding them, and links
   untracked env files (`.env.local` …) into each worktree.
2. Show the output to the owner. Change what they ask: `$ORCH config --set roles.worker=<model>` (also
   `checks='["npm run check"]'`, `baseBranch=develop`, `limits.checkers=2`, `harnesses.0.command=…`,
   `harnesses.0.when=merge` for a suite too slow for every round, `tests.rule=fail` …).
3. Run each harness once on the base branch: `$ORCH harness <name>`. If it fails there, it would fail every gate:
   tell the owner before going on. Ask too what the harness writes to (a real database, external services).
4. After their ok: `$ORCH config --confirm`. Nothing starts before that.

### Trackers
- **Backlog.md** (a `backlog/tasks/` folder in the repository): found by `$ORCH init` on its own.
- **Trello**: `$ORCH init --tracker trello --board <board id> --id-prefix RDZ` reads the board's open lists and proposes
  the statuses. Cards are `RDZ-<n>` (Trello's board number). Ask the owner, then set:
  `tracker.status.done` = the list a card goes to when it is merged into the base branch (where "Done" means
  production, that is a review list); `tracker.status.blocked` = a list, or `null` for a comment only;
  `tracker.priority` = which labels mean high/medium/low and which ones new cards get (`bracket: true` names them
  `[P2] …`). Two repositories on one board: `--filter-label <label> --filter-mode only|exclude` (the site works the
  cards with the label, the app the ones without; a card of the other repository is "not found" from here).
  Credentials: `~/.config/trello/config.json` (`{ "apiKey", "token" }`, `tracker.credentials` for another path) or
  `TRELLO_KEY`/`TRELLO_TOKEN`; never print them. The loop's fields live in the `orch` block at the end of each card's
  description, written only by `$ORCH card`: an existing free-text card is made workable with `$ORCH card normalise`.

### Delivery
- `delivery.mode: "local"` (the default): `finish` merges into the base branch of this checkout.
- `delivery.mode: "pr"` (`delivery.remote`, default `origin`; needs `gh` logged in): a task starts from the base
  branch as the remote has it; after a gate PASS, `$ORCH push <id>` commits exactly the gated tree, pushes the task
  branch (never over a push by someone else) and opens or updates the PR; the gate and checker verdicts appear on the
  commit as statuses. `finish` merges the PR with a merge commit only while its head is the checked sha; when the base
  moved it first merges the base into the task branch, runs the checks there and pushes. A finish that stopped
  half-way resumes; a PR merged by hand at the checked sha is recorded, never merged twice. A merge GitHub accepted
  but has not done yet (a merge queue, auto-merge), or whose answer was lost, is not a failure: run `finish` again
  later; the card cannot be split meanwhile. The worker never pushes.
  If GitHub merged into another branch or at another head (a PR retargeted at the last moment), the task is parked
  as `UNSAFE MERGE` (tracker: blocked) for the owner. If the base moved during GitHub's merge, `status` and `next` show
  `ATTENTION`. Both block the queue: `$ORCH next` exits 2 and starts nothing (`--json`: `{ "blocked": [{ id, unsafe,
  untested, next }], "eligible": [] }`), `$ORCH start` refuses. Tell the owner; once the merged result is checked or
  the owner decided, `$ORCH resolve <id> --checked "<what passed or was decided>"` reopens the queue. After the merge
  the remote task branch is deleted only if nobody pushed to it since.
- Network: every git command that talks to a remote fails instead of hanging: no credential prompts, a transfer
  stalled for 30 s stops, and `limits.networkTimeoutSec` (default 120) is the last resort. Without an ssh command of
  the user's own (`GIT_SSH`, `GIT_SSH_COMMAND`, `core.sshCommand`, which are always kept), ssh runs in batch mode:
  ssh-agent and known_hosts work, passphrase and unknown-host prompts are refused.
- Both modes: when the base moved since the start, the merge runs the project checks again; it repeats the gate's
  harnesses only if something besides the in-repo tracker, `.orchestrate/` and `merge.inertPaths` (globs that cannot
  change a build or a test, empty by default) moved. With `merge.recheck: "if-changed"` (default "always") the merge
  does not repeat the checks and the gate's harnesses when the merged tree is the gated one apart from those inert
  paths and the checks and harnesses are unchanged since the gate (same bytes, same verdict); `when: merge` harnesses
  always run. A harness the card did not trigger is not run at the merge for a change that came only from the base.
  Keep the scripts that checks and harnesses run outside `.orchestrate/` (it counts as inert); in PR mode the
  `when: merge` harnesses now run on every finish, in the worktree, and must not leave files there.
- The task-branch commit is made from the gated tree itself: worktree commit hooks no longer run on it. A commit hook
  that changes the merge commit in the main checkout makes it an untested merge (the queue waits for `orch resolve`).

## Tests and harnesses
- **Checks must see what the worker sees.** The worker never commits or stages: its new files are untracked until the
  gate stages them. A project check that lists files with git (`git ls-files`, a census or ownership test) must include
  untracked files (`git ls-files --cached --others --exclude-standard`), or it passes for the worker and fails at the
  gate (Tourguide: 28 failed gates from one such check). Tell the owner when you see one.
- **Artifact lifecycle (opt-in):** `artifacts.enabled=true`, `artifacts.minFreeBytes=<bytes>` and
  `artifacts.disposable=["*/runtime/.next","*/node_modules"]`. Gate, merge and harness commands receive a unique
  TMPDIR under a sibling `.orchestrate-artifacts/<project-id>/command-*/tmp`, outside the checkout so retained
  source snapshots cannot enter its compiler/test scans. Before starting, both the artifact and checkout filesystems
  must have the configured headroom; otherwise the result is INFRA, not a failed correction. The owner approves
  the disposable patterns for the project. Only matching real directories created inside that command's scope
  are removed after success and verified Linux process shutdown. Source, logs, reports and receipts remain.
  Failed/interrupted commands, uncertain process ownership and non-Linux hosts retain all files. Nothing scans
  old /tmp, parked worktrees or another scope. Hardcoded /tmp and worktree-local builds remain project-owned.
  Workers/checkers use `node <skill>/scripts/managed-check.mjs "<command>" <timeoutSeconds>` for their own checks;
  raw shell commands bypass this protection. Retention warnings require an owner decision, not infinite retries.
  No model, cron, result cache or skipped test is involved. See `ARTIFACTS.md` for limits and upgrade safety.
  **Cleanup:** every scope records its run; `orch finish` deletes all scopes of the merged run, `orch fix` those of
  the rounds before the last two, and the campaign keeper runs `$ORCH artifacts gc` on every tick (also parked or
  set-aside runs after `artifacts.keepDays`, default 14). `$ORCH artifacts` lists what is kept, deletable and
  unowned; unowned scopes (older releases) go only with `$ORCH artifacts gc --unowned`, on the owner's request.
  **Temporary files of sub-agents:** worker, fix and checker briefs assign each run its own
  `.orchestrate-artifacts/<project-id>/run-<ID>/tmp` and tell the sub-agent to export it as TMPDIR in every command;
  it is deleted with the run's scopes when the run is merged (parked or set-aside runs after `keepDays`).
  **System temp backstop (opt-in):** `artifacts.tmpSweep: { "days": 2, "dir": "/tmp", "keep": ["name", "prefix*"] }`
  (`dir` defaults to `/tmp`) makes the keeper, on every tick, and `$ORCH artifacts gc` delete the top-level entries
  of that folder that have nothing changed inside for `days` days and that no process uses (Linux only, and only when
  every process can be inspected — in practice a keeper running as root, as in Rev4a agent containers). Hidden and
  system names, links, mounts, folders holding a socket or pipe, the checkout, its worktrees and `keep` entries are
  never touched. `$ORCH artifacts` previews it (or says why it cannot run); deletions are logged in
  `.orchestrate/housekeeping.log`.
- **Checks** (`checks`) run at every gate. **Harnesses** run at the gate (or only at the merge, `when: merge`) when
  the change touches their `paths`, or when the task names them in `harnesses:`. One harness runs at a time, and none
  runs when the scope, a check or the test rule already failed the gate. A gate harness the change does not reach is
  reported as `SKIP`, never silently.
- **A slow check belongs in `harnesses`** with `kind: "check"` and the `paths` that can change its result (keep the
  fast ones in `checks`): it then runs only for cards that touch those paths and for closure cards. Its paths include
  the tool's global inputs (package.json, the lockfile, the tool's config, tsconfig, `.orchestrate/config.json`). The
  gate shows how long every check and harness took: one that takes most of the gate is the one to move.
- **Fast gate** (a harness with `fast: { critical: [...] }`): the gate runs the card's own spec files plus the critical
  ones. The whole suite runs only for a **closure card** (a card other cards name as `parent_task_id`) and when the change
  touches `risk.paths` (database, migrations, shared code). A whole-suite failure is rerun once on the failed specs
  (passing then = flaky, a WARN); a real failure lists the cards merged since the last whole-suite pass — open a small fix
  card for the likely culprit. Workers and checkers never run the whole suite themselves.
- **Test with the change**: a change to source code without a changed test file is reported by the gate
  (`tests.rule`: warn, fail or off). The owner can exempt a task with `no_tests: <why>` in its front matter.
- `$ORCH next` gives **advice** on tasks: no test file among its owned files (the worker could not add one), or
  nothing but the project checks verifies it. Propose the missing piece to the owner before starting: a specific
  spec file in `modified_files`, a `checks:` command, or `no_tests`.
- When splitting a task that changes pages or flows, give each new task the spec that covers it (for example
  `tests/e2e/02-session-orders.spec.ts`), not a whole test folder: whole folders make every task overlap.

## The loop
1. `$ORCH next` → eligible tasks, best first (`--all` says why the others wait). Pick the first unless the owner
   said otherwise. Exit 2 means the queue is blocked by a merge that needs a person (see Delivery): not a crash; read
   its `next:` line, tell the owner and wait.
2. `$ORCH start <id>` → worktree + branch, status In Progress, the worker brief written to a file.
3. Spawn the **worker** exactly as the `next:` line says: OpenClaw `sessions_spawn` with `runtime: "subagent"`, the
   `label` and `taskName` it gives (the label names the session in Rev4a's Lineage, e.g. "SB-60.2 worker r1"), the
   configured model, `cwd` = the task worktree, `runTimeoutSeconds`, and a one-line task: `Read <brief file> and do what
   it says.` Do not paste the brief. This is **OpenClaw delegation** of a whole card to a separate OpenClaw session,
   which runtimes allow `sessions_spawn` for — not internal legwork. **Never use a runtime-native child (Codex
   `spawn_agent`)** for workers or checkers, even if your runtime suggests it for other work: native children can stop when your turn changes and their completion may never reach you, while an
   OpenClaw sub-agent has its own lifecycle, wakes you when it ends and shows in Rev4a's Lineage. Then `sessions_yield`.
4. When it announces it is done: `$ORCH record <id> worker`, then `$ORCH gate <id>`.
5. Gate FAIL → `$ORCH fix <id>` and spawn the worker again with the fix brief. Gate PASS → (with `delivery: pr`,
   first `$ORCH push <id>`: it commits the gated tree, pushes it and opens or updates the PR) → spawn the **checker**
   the same way (`sessions_spawn`, configured checker model, always a new sub-agent) with `Read <checker brief> and do
   what it says.`
6. When it announces: `$ORCH record <id> checker` (`--tag b` for a second checker).
   FAIL → `$ORCH fix <id>`. NEEDS EVIDENCE with no FAIL → `$ORCH recheck <id>`: no checker found a defect, so the
   checkers run again in the same round, once, without using a correction round (`fix` refuses until then, unless the
   worker really must add something checkable: `fix --anyway`; after a second NEEDS EVIDENCE it is `fix`). PASS → ready.
7. Tell the owner in three lines: task, gate numbers, checker verdict. Without a standing approval, ask for the
   merge ok and wait.
8. On their ok: `$ORCH finish <id> --approved-by <name>` (with a standing approval: `$ORCH finish <id>`, then
   tell them it was merged). It commits, merges `--no-ff` into the base branch, runs the
   checks again on the merged result (and aborts the merge if they fail), sets Done and removes the worktree.
   With `delivery: pr` it merges the PR on GitHub instead, only at the sha that was pushed and checked (see Delivery).
9. `$ORCH next`.

**GATE: INFRA** means the machine stopped a check or harness (out of memory, killed): it says nothing about the change
and uses no correction round. Run `$ORCH gate <id>` again; if it happens twice in a row, tell the owner. Checks and
harnesses never see the agent's credentials (OpenClaw, GitHub, Trello, Vercel, model keys; `env.strip`/`env.keep` in
the config adjust the list).

If `finish` stops half-way (killed, a tracker error), run it again: it never merges twice, it does only the steps
that are missing (`orch status` lists them).

If a sub-agent answered only in chat and wrote no report file, save its final answer, unchanged, to the path the brief
named (or pass `--from <file>`). If it ran out of time or failed without an answer, start it again with the same brief
(rule 11): a worker's partial work is still in the worktree, and the gate decides on it.

## Campaigns: working a queue to the end
When the owner asks to work a set of cards to the end, the runtime does not start your next turn by itself: if you
end a turn while work remains, nothing moves. Two rules and one helper:
- **Never end a turn with eligible work and nothing running.** After every closure (`finish`, `park`) run `$ORCH next`
  in the same turn and start the next card. End a turn only to wait for a running sub-agent or process (its completion
  wakes you), when a person must decide (say what, in one line), or when `$ORCH campaign status` says done.
- **A campaign records the mandate**: `$ORCH campaign start --session <your session key> --scope all|ID,ID --by
  <owner>` (only on the owner's request; one campaign and one coordinator at a time), `$ORCH campaign status`,
  `$ORCH campaign stop`.
- **The keeper** wakes you when you stopped by mistake. `$ORCH keeper --json` (run only by the job: it records the
  wakes; to look, use `$ORCH campaign status`) decides without a model, looking at
  every open run in the campaign's scope: `wake` (a step waiting for you, or eligible work while no sub-agent runs,
  and no orch command for `idleMinutes`, default 10; or a sub-agent past its time limit), `wait`, `escalate` (a
  person must decide: an unsafe or unchecked merge, a run at its round limit, every remaining card waiting, a command
  running longer than any sub-agent may, or 3 wakes without progress), `done` (the campaign ends itself), `off`. A
  ready card without consent is reported to the owner while the other cards keep moving. A sub-agent report left in the
  run's inbox and not recorded for `idleMinutes` (its completion never reached you) wakes you to `orch record` it. On
  OpenClaw the keeper also reads the runtime's sessions (`openclaw sessions`, the coordinator's own agent): a worker or
  checker that was never started, or whose session ended without a report, wakes you once the phase has been open for
  `idleMinutes`; keep the labels `orch` gives ("<id> worker r<n>", "<id> checker <t> r<n>"), a suffix after a space is
  fine. A
  sub-agent past its time
  limit wakes you once per time limit: check its session, and start it again only if it is gone. Cards split from a
  card in the scope are in the scope. Wakes back off 10, 20, 40 minutes; each escalation is reported once, again only
  after it cleared. On a host without `/proc` only a running harness counts as busy. Install it once per project as an OpenClaw script job (no
  model turn unless it acts): `$ORCH campaign job-script > keeper.js`, then
  `openclaw cron add --agent <agent> --name orch-keeper --every 5m --script keeper.js --session main`. A wake arrives
  as an `[orch keeper]` inter-session message: treat it as the owner's standing mandate, run `$ORCH status` and act.
  Notices for the owner (a ready card without consent, a round limit, an unsafe or unchecked merge, every card
  waiting, a hung command, a stuck campaign, the campaign complete) arrive the same way, in your conversation, because
  the owner reads it there (dashboard or chat channel): tell the owner in one line (nothing new if you already did) and
  wait for a decision it needs; do not act on a notice yourself. After a skill update, regenerate the job script
  (`$ORCH campaign job-script`) and replace the job's script: an older script keeps the older behaviour.

## When it does not converge
- Round limit reached: `$ORCH status <id>` lists the choices. Accepting without a checker PASS needs the owner's ok
  and `--override "<why>"`; a failing gate is never merged.
- When the owner lets you decide at the limit (`limits.atRoundLimit: "coordinator"`, set with `$ORCH config --set
  limits.atRoundLimit=coordinator` and confirmed by the owner), you do not wait for them: `$ORCH prompt <id> advisor`
  writes an advisor's brief; delegate it to one sub-agent (label `<id> advisor r<n>`), then split the card (`$ORCH card
  split`) or park it, tell the owner in one line what you decided and why, and go on with `$ORCH next`. Never merge it:
  a card is merged only after a gate PASS and a checker PASS. The keeper wakes you for it instead of the owner.
- Blocked by something outside the task: `$ORCH park <id> --reason "<why>"` (status Blocked, worktree kept) and tell
  the owner.
- Merge refused (conflict, checks fail on the merged result): nothing was merged. Park it, or start a new small task
  that rebases it.

## Cards
Cards are created and changed only with `$ORCH card`, never by editing the tracker by hand: you write the content as
JSON, the script writes the tracker's format and refuses a card the loop could not work.

    { "title": "Menu: prices in the venue currency",
      "goal": "What the change must achieve and why, in a few sentences.",
      "acceptance": ["The menu shows prices in the venue currency in EN and IT.", "A unit test covers EUR and GBP."],
      "owned": ["app/menu/list.tsx", "tests/i18n/menu.test.ts"],
      "kind": "code", "dependencies": ["SB-61"], "checks": [], "external": [], "priority": "high" }

- `kind`: `code` (when it owns source code: must own a test file or give `"noTests": "<why>"`), `test`, `content`
  (docs, copy), `migration` (owns the migration file; `orch next` never starts it beside another migration card, and
  the worker never applies it to a shared database). A card without `kind` gets one from its owned files.
- `acceptance`: statements the checker can verify one by one; `owned`: the files or narrow globs it changes
  (`app/menu/**`, not `app/**`); a page or flow change owns the spec that covers it (`tests/e2e/02-orders.spec.ts`).
- `external`: paid or outside services the change touches (`image-generation`). The worker and checker briefs say
  never to call the real service and to list what only it can show as `MANUAL: <flow> — …` lines for the owner.
  Declare the project's flows in the config: `external.flows: { "image-generation": { "howToTest": "intercept
  POST /api/images in Playwright and return a fixture" } }`.
- `$ORCH card new --from card.json` · `$ORCH card split <id> --from cards.json` (an array; the children get the
  next free numbers under it, `<id>.1`, `<id>.2` …, and the parent becomes their closure card: `orch next` starts it
  only when they are all done; a split card cannot depend on its parent. Splitting a card that has a run, as the
  owner may choose at the round limit, sets that run aside: its state goes to `.orchestrate/archive/`, its worktree
  and branch get a `-before-split-<time>` suffix, nothing is deleted, and the card goes back to To Do. It is refused
  while a sub-agent works on the card, on an unsafe merge not settled (`orch resolve`), or when a finish was
  interrupted (run `orch finish` first). If a step fails half-way
  (a locked worktree, a tracker error), fix the cause and run `$ORCH card set-aside <id>`: it goes on from there) · `$ORCH card check <id>` · `$ORCH card normalise <id>`
  (prints an old free-text card as JSON with what it lacks; fill it in, then `--from <file>`). `--dry-run` writes
  nothing. Errors block the write; warnings (overlap with a running card, a file not created yet) do not.
- New cards and splits change the scope of the work: propose them to the owner first, unless the owner authorized
  new cards for this wave.

## Splitting
A good card is done in one worker round by the configured worker model and does not overlap the cards that may run
beside it. When a card is too large, propose the split (titles, owned files, acceptance, dependencies), then
`$ORCH card split <id> --from cards.json`.

## Files
- Skill (Rev4a's, read only): `SKILL.md`, `scripts/` (`orch.mjs`, `lib/`, `trackers/backlog-md.mjs`,
  `trackers/trello.mjs`), `templates/`.
- Project (the owner's): `.orchestrate/config.json`, optional `.orchestrate/NOTES.md` (short facts about the
  project that a worker brief should not miss).
- Runs (the script's, git-excluded): `.orchestrate/runs/<id>/` — `state.json`, prompts, reports, gate results, logs.
