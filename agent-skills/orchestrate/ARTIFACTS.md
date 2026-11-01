# Command-owned build artifacts

This opt-in extension prevents successful managed checks from accumulating declared disposable builds. It is
independent of PR delivery. Configuration defaults to `artifacts: { enabled: false, minFreeBytes: 0, disposable: [] }`.
Use a measured per-project disk reserve, not a universal promise that an arbitrary build will fit.

Each managed shell command gets a new `../.orchestrate-artifacts/<project-id>/command-*/tmp` as TMPDIR/TMP/TEMP.
The project ID is its directory name plus a 12-character hexadecimal SHA-256 prefix of its canonical checkout path.
This is outside the checkout: retained TypeScript/test snapshots cannot enter project compilation or test scans.
Its sibling
`receipt.json` records owner PID, checkout, timestamps, exact candidates (logical file bytes), removals and outcome.
`ORCH_ARTIFACTS_DIR` identifies this scope. Gates and merge checks use this automatically after loadConfig;
workers/checkers must use `node <skill>/scripts/managed-check.mjs "command" timeoutSeconds`.

Disposable declarations are relative segments with optional single-level `*`, ending in `.next` or `node_modules`.
For example, Tourguide's `*/runtime/.next` matches a private snapshot build; `*/node_modules` matches a private clean
install. A linked shared node_modules is never traversed. Source snapshots, .git history, patches, fixture receipts,
server logs, reports and traces outside those declared build directories are retained. Do not declare a build
directory disposable if the project keeps irreplaceable evidence there; fix its harness layout first.

Cleanup requires command success, no interruption, an empty shell process group, and Linux /proc inspection of
same-UID processes for inherited scope markers, working directories and open files. Uninspectable processes and
other platforms retain everything. This is cooperative lifecycle management, not a sandbox against hostile code
that intentionally strips markers, detaches and accesses paths later. Do not share a command's private directory
with another worker. The runner never kills detached groups found by inspection; it retains their files instead.

Failure, timeout, SIGKILL, uncertain process shutdown or cleanup errors do not trigger later automatic sweeping.
A receipt left at `running` or `cleaning` needs explicit diagnosis. Cleanup errors return INFRA; ordinary test
failures retain their original exit code. Headroom is checked on the checkout and artifact filesystem before
each managed command; a failure stops that command without spending a correction. The reserve is not a disk quota.

This does not clean historical /tmp, dependencies or .next directly in a worktree, hardcoded absolute temp paths,
raw unwrapped worker commands, detached tasks still running, or all failed attempts. It also does not clean
database fixtures: a harness must finish and verify its own fixture cleanup before reporting success. Persistent
evidence can still grow and requires an explicit retention policy after project acceptance requirements are known.

## Upgrade safety

1. Existing data: additive optional config only; databases, credentials, agent volumes and old runs are untouched.
   Old runs have no ownership proof and are never silently adopted for deletion.
2. First run: no legacy directory scan or migration. New scopes only; preflight uses statfs. Process inspection
   runs after each managed command. Commands already running during installation keep their original environment.
3. Older agents: Node built-ins only, no OpenClaw API dependency. Linux enables safe cleanup; other systems retain
   artifacts. Install against the agent's existing local-delivery baseline, not unreleased PR delivery changes.
4. Visible changes: enabled projects get private temporary paths and a disk reserve; declared reconstructible
   builds disappear after successful checks. Failed-run evidence remains. Tests and acceptance criteria still run.
5. Rollback: restore the saved skill and config; old code can read existing run state. New artifact receipts are
   independent of run state. All source/evidence remains; removed builds can be recreated from the retained source.

## Automatic cleanup (2026-11-01)

A receipt records its run (`ORCH_RUN`, "<id> r<round>", set by orch for gates and merges); a scope without a label is
attributed by its working directory (the run's worktree). Only receipts written by this release (they carry the `run`
field) are attributed: scopes of older releases have no ownership proof and are never deleted automatically, nor are
commands left `running` or `cleaning` (they need a diagnosis); both are listed as unowned. `orch finish` deletes every scope of the merged run,
`orch fix` the scopes of rounds before the last two (the last failed attempt stays for diagnosis), and the campaign
keeper runs the same collection on every tick, which also deletes the scopes of parked or set-aside runs older than
`artifacts.keepDays` (default 14). A scope is deleted only when it finished, its owner process is not alive and, on Linux, no
process uses it (one /proc pass per collection); on other systems only the owner process is checked. A run that waits
for the owner (an unsafe or untested merge) keeps its scopes. The keeper deletes at most 100 scopes per tick, after
its decision is out. Scopes no run owns are listed by `orch artifacts` and deleted
only with `orch artifacts gc --unowned`, on the owner's request. The keeper tells the owner once when free disk falls
below twice `minFreeBytes`.

Historical cleanup is a separate, exact inventory and approval. This extension safely contains future managed
runs; it cannot automatically repair unowned legacy artifacts without proving their ownership and inactivity.
