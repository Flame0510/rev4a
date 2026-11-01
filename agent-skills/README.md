# Agent skills

Skills that Rev4a develops for the OpenClaw agents it runs, versioned here with the rest of the code.

They are **not** part of the npm package (`agent-skills/` is not in `package.json` `files`) and Rev4a does not
install them: an update of Rev4a changes nothing on any agent. Today a skill is installed on an agent by hand, as an
immutable release folder in the container that the agent's public skill files forward to; installing and updating
them from Rev4a is planned. Skills Rev4a does install itself live in `rev4a-skills/` (see `docs/ARCHITECTURE.md`,
Shared Skills).

| Skill | What it does |
|---|---|
| [`orchestrate`](orchestrate/SKILL.md) | Works a project's backlog with sub-agents: scripts pick the next card from the tracker (Backlog.md or Trello), make a git worktree and keep all state; a worker sub-agent writes the change, a gate runs the project's checks, an independent checker sub-agent tries to break it, and the merge (local, or through a GitHub pull request) needs the owner's consent. A campaign keeper, run as an OpenClaw script job, wakes the coordinator when it stops with work left and sends the owner's notices into its conversation. |

## Rules for changes

- Same rules as the rest of the repository: 100% English, no Python, Node built-ins only.
- Every change keeps the skill's own suites green; `npm test` runs them (`scripts/test-orchestrate-skill.mjs`).
  The pull-request suite needs a GitHub sandbox repository and runs only on request:
  `ORCH_PR_SANDBOX=<owner>/<repo> node agent-skills/orchestrate/test/e2e-pr.mjs`.
- A change that reaches agents keeps working with the state files, briefs and job scripts that earlier releases wrote
  on them (runs in flight, `campaign.json`, checker report names): the same upgrade-safety rule as Rev4a itself.
