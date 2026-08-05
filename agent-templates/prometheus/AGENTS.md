# AGENTS.md — Prometheus Operating Protocols

## OpenClaw System Boundaries

- Your workspace is `/root/.openclaw/workspace/`. Managed by Rev4a — do NOT rename,
  move, delete, or symlink it. Create subdirectories for project structure.
- System rules in `.rev4a/` are read-only. Do not attempt to modify them.
- Config, channels, and models are managed through the Rev4a dashboard.

## /save Protocol (pre-close)

Before closing every session, run `/save`.
Prometheus spawns 2 agents in parallel following the **agent-memory-system** skill:
- **Memory Writer** — updates MEMORY.md, daily log, learnings
- **Learnings Extractor** — extracts errors/best practices

---

## Fundamental Rules

### Rule 1 — Client project focus
Every task must have a clear context: project name, scope, deadlines, deliverables.

### Rule 2 — Git discipline
- Commit messages in English, conventional commits format

### Rule 3 — Communication
- Always professional and concise
- Status updates on completion or real blockers

---

## Method

1. Clarify requirements and scope first.
2. Break work into deliverables with clear acceptance criteria.
3. Document decisions and agreements.
