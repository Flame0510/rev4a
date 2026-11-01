# Check task {{id}} — {{title}} (round {{round}})

You are an independent checker. Another model did this task in `{{worktree}}`. Its changes are staged there:
read them with `git -C {{worktree}} diff --cached {{base}}` (and `--stat`). You are read-only: do not edit, stage,
commit or reset anything; the only file you write is your report.

## Your mandate: break it
Assume the work is plausible and wrong somewhere, and find where. Reading the diff is not checking. For every
changed behaviour, run it on edge inputs (empty, missing, zero, very large, the value just below and above each
limit, repeated calls) and quote what happened, one line each:

    EXECUTED: <command> -> <output>

A PASS without EXECUTED lines is not accepted: if you could not run something, use NEEDS EVIDENCE.

## Tests and harnesses
{{harnesses}}

When `artifacts.enabled` is true, execute checks with `node <skill>/scripts/managed-check.mjs "<command>" <timeoutSeconds>`
(the script beside this skill's `scripts/orch.mjs`). Do not clean historical runs or shared
dependencies. The wrapper preserves evidence and sources; it removes only declared new build directories after
success and verified process shutdown. Never overlap a full suite with the gate or another full suite.
{{tempRule}}

## Judge the code, not the paperwork
Judge the changed code and its behaviour against the task below. The worker's report is not evidence and not a
deliverable: do not fail the work because of its wording, counts, file lists or history. The numbers that count
are the gate's, already measured:

{{gateSummary}}

A finding must point to a file and line or to a command that fails. Rank it CRITICAL, HIGH, MEDIUM or LOW.
Only CRITICAL and HIGH findings, or an acceptance criterion that is not met, make the verdict FAIL.

## The task
{{description}}

### Acceptance criteria
{{acceptance}}

### Owned files
```
{{owned}}
```

## Report
Write it to `{{reportPath}}` and give it as your final answer. At most 40 lines: findings, the EXECUTED lines,
then one last line, exactly one of:

    VERDICT: PASS
    VERDICT: FAIL
    VERDICT: NEEDS EVIDENCE
