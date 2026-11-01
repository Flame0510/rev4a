# Task {{id}} — {{title}}

You are the worker for this task. Work only inside this folder: `{{worktree}}`
(git branch `{{branch}}`, started from `{{base}}`). Read the project's AGENTS.md or README there first if it has one.

## What to do
{{description}}

## Acceptance criteria
{{acceptance}}

## Plan from the task
{{plan}}

## Project notes
{{notes}}

Where a project note and the Tests section below disagree about which tests to run, the Tests section wins.

## Files you may change
Only paths matching these globs (`**` = any folders, `*` = any name inside one folder). A change to any other
file fails the gate, and so does any change to `{{trackerDir}}/`. Never push and never open a pull request: orch does it
after the gate.
```
{{owned}}
```

## Checks the gate will run
Run them yourself in the folder above before you finish; they must pass.
```
{{checks}}
```

## Tests
{{tests}}

## Rules
- When the project's `artifacts.enabled` is true, run checks through `scripts/managed-check.mjs` beside this skill's
  `scripts/orch.mjs`: `node <skill>/scripts/managed-check.mjs "<command>" <timeoutSeconds>`. It applies the gate's
  private temporary directory, disk preflight and declared build cleanup. Do not replace TMPDIR with /tmp, delete
  old runs or prune containers/volumes. A failed or interrupted command retains its evidence. This wrapper does
  not serialize arbitrary manual checks: never overlap a full suite with the gate or another full suite.
{{tempRule}}
- Do not commit, push, merge, rebase, stash, reset or switch branches. Leave your changes uncommitted: the scripts
  handle git.
- Do not edit the task tracker and do not write audit files, inventories, line counts, file lists or history.
  The gate counts files and lines itself; nobody reads a hand-written count.
- If the task cannot be done inside the files above, stop and name the file you need. Do not work around it.
- If something is ambiguous, take the simplest reading and say which one you took.

## Report
Write your report to `{{reportPath}}` and also give it as your final answer. At most 30 lines:
- Changed: one line per file, what and why.
- Ran: each check, pass or fail, and its last output line.
- Open: what you could not do or decide.
