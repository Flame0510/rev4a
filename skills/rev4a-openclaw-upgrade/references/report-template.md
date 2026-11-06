# Report template

Write the report **in English** (it feeds tracked files, PRs and cards) and save it to
`plans/<card>-openclaw-<FROM>-<TO>.md` in the active evaluation worktree (`plans/` is git-ignored; without it,
`$WORK/report.md`). Never commit it. The owner gets a short summary **in their language**, with the
report's path: the verdict, what was proven live, what was only read, what is still running.

Rules for both shapes:
- Every claim carries its evidence or a pointer to it: a file:line in the package, a snapshot item, a
  `$WORK` file, a log line, a command and its output. Facts first; a recommendation follows the facts
  it rests on.
- The independent checker (SKILL.md step 11.2) reads the draft before the owner does. What it could not
  confirm moves to "Not proven"; what it discarded is listed there with the reason.
- Text that will go into a tracked file or a PR (the history entry, a fix's description) leaves out
  host names, local paths and agent ids. The "Test environment" section stays in this report.

## Full track

```markdown
# OpenClaw FROM → TO: evaluation (<date>, <card>)

## Verdict
One paragraph: can Rev4a offer TO, after which fixes; does it fix what motivated the move (with the
proof, or what is still unproven); which release-gate items remain.

## Track
Full, and why (a new line, or the rows that escalated a minor run). Paste the final `triage.md` table
(P1-P4, T1-T15): on a full run its rows are still evidence (what changed statically and live).

## Blockers
Problems that keep TO from being offered. For each: what happens to users, the evidence, the fix in
Rev4a (files), and the state already written by the old code with its repair for installs already hit
(AGENTS.md §2.2c): how it runs (startup or daemon), and how it was tested.

## Rev4a fixes (not blocking)
Same shape, lower stakes: deprecations with a deadline, fragile parsing that held this time, texts that
describe the old behaviour (`rev4a-rules/`, templates, `docs/rag/`, the assistant page catalogue).

## Owner decisions
Behaviour changes users will notice. For each: before, after, who is affected, the options (including
"let OpenClaw's default apply" and "set the config key that keeps the old behaviour"), and a
recommendation.

## Time-delayed effects
Each behaviour with a timer or a counter (archived after N days, reviewed after N turns, a deprecation
date): what triggers it, when it hits a typical agent, whether Rev4a can see it, the decision it needs.

## Verified unchanged
The inventory areas checked, each with how (snapshot item, `rev4a-deps` assertion, API call, page), so
the next evaluation knows what was proven. List apart the snapshot items flagged "not exercised"
(empty on both sides): they prove nothing.

## Older agents (update sources)
| From | Update | Verification | Rollback | Notes |
|---|---|---|---|---|
| FROM | | | | |
| OLDEST | | | (image downloaded again?) | |

## Rehearsal on real data
Which backup (kind and size only, no names); what `neutralize-backup.mjs` removed (its printed list, as
counts) and what it kept; then: baseline and backup time,
`doctor --fix` time, the whole update against the 10-minute first window, peak memory, `.bak` bytes,
skills, plugins and pending proposals before and after, `schema-diff --config` on each real config (`schema-diff-real.md`; channels were removed, so the
candidate's migrated config covers them).

## Measurements
| | FROM | TO |
|---|---|---|
| Startup, idle host (s) | | |
| Startup, under load (s) | | |
| Idle memory (MB) | | |
| Memory under Rev4a's reads (MB) | | |
| Image size | | |

Also: update duration, fresh create duration, rollback duration, disk left by migrations (`*.bak`), the
minimum memory limit for TO, the result of the old-recommended-limit test, and the free disk an update
of an agent of size X needs (image + backup + `.bak`).

## Rollback
Right after changes made on TO (model, Edit, Recreate, credential): the result, what a rollback loses,
model and config consistency afterwards. Restore across versions: a TO backup onto FROM, a FROM backup
onto TO. Rev4a's own rollback: the previous Rev4a with an agent on TO.

## Upgrade safety (AGENTS.md §2.2c)
1. Existing data:
2. First run after the update:
3. Older agents:
4. Behaviour users will notice (release notes):
5. Rollback:

## Release gate (SKILL.md step 13)
| Item | State | Evidence |
|---|---|---|
| Rev4a fixes released first (version) | | |
| Image published (`:<TO>-<sha>`), amd64 and arm64 in the manifest | | |
| Published tag run on amd64 and arm64 (version, Node, create, update, rollback, startup) | | |
| `imageRevision` pinned in `lib/agent-versions.json` | | |
| Release notes (decisions, minimum memory, rollback loss, delayed effects) | | |
| Canary agent and watch window | | |
| Withdraw plan | | |

Watch list for the canary: the commands, and what counts as a failure.

## User-facing text
The release-note paragraph, the docs and website pages to update, any in-app text.

## Not proven
Steps skipped and why, tests still running (a soak), anything only read and not run, and what the
checker could not confirm or discarded.

## Side findings
Rev4a defects found on the way that TO did not cause. Kept apart; each is proposed as its own card.

## Test environment
Host, Docker memory, images (tags, revisions, local or published), test agents (ids, limits, ports),
the run log's path, and what was cleaned up or left running.
```

## Minor track

```markdown
# OpenClaw FROM → TO (minor): evaluation (<date>, <card>)

## Verdict
Go / no go / escalated to the full track at <trigger>; one sentence on what motivated the move.

## Triggers
| # | Result (`ok` / `full` / `check` / `open` / `unverified`) | Proof |
|---|---|---|
(P1-P4 and T1-T15, every row of the final `triage.md`, run after `manual.json` was written; plus,
by hand, "no blocker of the line's full evaluation is still open". `open` or `unverified` is not a go.)

## Live checks
Update (status, duration); `compare.md` (its Triage list and the "not exercised" items) and
`rev4a-deps.md` in a few lines; the smoke set (one line
each, with the command or page); fresh create (duration); memory and startup against T14 and T15 (the `manual.json` values);
rollback (status, version, databases, cron jobs, chat turn).

## Upgrade safety (AGENTS.md §2.2c)
1-5, one line each.

## Release gate
The same table as the full report.

## Not proven
What was only read, what was skipped and why, what the checker could not confirm.

## Side findings
Rev4a defects not caused by TO; each proposed as its own card.

## Test environment
Host, images, test agents, what was cleaned up.
```
