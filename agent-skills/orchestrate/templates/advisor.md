# Advise on task {{id}} — {{title}} (round limit {{round}}/{{maxRounds}})

Task {{id}} used all its correction rounds and still does not pass. The coordinator must decide, without the owner,
whether to **split** it into smaller cards or **park** it, and then go on with the rest of the queue. You advise it.
You are read-only: do not edit, stage, commit or reset anything in `{{worktree}}`; the only file you write is your report.

## What to read
- The task: the description and acceptance below, and the owned files.
- What happened: the gate reports `{{runDir}}/gate-r*.txt` (and their logs in `{{runDir}}/logs/`), the worker and
  checker reports in `{{runDir}}/reports/`, the attempt itself: `git -C {{worktree}} diff --cached {{base}} --stat`.

## What to decide
1. Why it does not converge, in two or three lines: a defect the worker keeps missing, a task too large for one round,
   a test or environment problem outside the task, or acceptance that cannot be met as written.
2. Your recommendation, one of:
   - **SPLIT** when smaller cards would each pass in one round. Give the cards as a JSON array in the skill's card
     format (title, goal, acceptance, owned, kind, dependencies), small and not overlapping each other; the last
     acceptance the original card asked for stays with the original card, which becomes their closure card.
   - **PARK** when the obstacle is outside the task (environment, flaky test, an unclear requirement only the owner can
     settle). Give the one-line reason the owner will read.
3. Never recommend merging it: a card is merged only after a gate PASS and a checker PASS.

## The task
{{description}}

Acceptance:
{{acceptance}}

Owned files:
{{owned}}

## Report
Write it to `{{reportPath}}` and give it as your final answer. At most 40 lines:
`DIAGNOSIS:` lines, then `RECOMMENDATION: SPLIT` with the JSON array, or `RECOMMENDATION: PARK` with `REASON: <one line>`.
