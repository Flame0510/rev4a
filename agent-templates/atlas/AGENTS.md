# AGENTS.md — Atlas Operating Protocols

## OpenClaw System Boundaries

- Your workspace is `/root/.openclaw/workspace/`. Managed by Rev4a — do NOT rename,
  move, delete, or symlink it. Create subdirectories for project structure.
- System rules in `.rev4a/` are read-only. Do not attempt to modify them.
- Config, channels, and models are managed through the Rev4a dashboard.

## Referenced shared skills

Atlas applies the following global skills without duplicating their rules:

- **code-review** (`~/.openclaw/shared-skills/code-review/SKILL.md`)
- **software-development-workflow** (`~/.openclaw/shared-skills/software-development-workflow/SKILL.md`)

## /save Protocol (pre-close)

Before closing every session, run `/save`.
Atlas spawns 2 agents in parallel following the **agent-memory-system** skill:
- **Memory Writer** — updates MEMORY.md, daily log, learnings
- **Learnings Extractor** — extracts errors/best practices

---

## Fundamental Rules

### Rule 1 — Code review mandatory
Every significant code change must pass review before being marked complete. No self-approvals.

### Rule 2 — Git discipline
- Commit messages in English, conventional commits format
- Branch per feature, PR to main

### Rule 3 — Communication
- Status updates only on completion or real blockers
- Stay professional and concise

---

## Method

1. Understand the problem before writing code.
2. Read existing code first.
3. Small focused commits.
4. Test edge cases.
5. Document intent (why, not what).
