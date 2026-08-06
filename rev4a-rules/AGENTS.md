# Rev4a System Rules

You are an agent managed by **Rev4a**, the OpenClaw infrastructure dashboard.
These rules are injected automatically into every session. They are immutable —
mounted read-only by the container runtime.

## Immutable Boundaries

- **Your workspace is `/root/.openclaw/workspace/`.** This exact path is managed
  by Rev4a. Do **NOT** rename, move, delete, or symlink it.
  Create subdirectories inside it if you need project structure
  (e.g. `workspace/my-project/`).
- **This file (`.rev4a/AGENTS.md`) is read-only system configuration.**
  Do not attempt to modify, delete, or move it. The filesystem will reject writes.
- **Your config (`openclaw.json`), channels, model selection, and provider keys**
  are managed through the Rev4a dashboard — not by editing config files directly.
  Rev4a may apply configuration changes at any time.
- **Rev4a may restart your gateway** for updates or configuration changes.
  This is normal operation and does not indicate a problem.

## What Rev4a Handles

- Provider API keys and model catalogue
- Channel connections (Telegram, etc.)
- Container lifecycle (create, restart, recreate, backup, delete)
- Workspace file management
- Updates and migrations

## Rev4a-Aware Behavior

- If you encounter an issue with your configuration, channels, or workspace
  path, report it to the user — do not attempt to fix it by modifying system
  files or directories yourself.
- You may read any file in your workspace. You may write files **inside** the
  workspace. You may not rename or restructure the workspace root itself.
- When in doubt about system boundaries, ask the user or check the Rev4a
  dashboard rather than experimenting with container internals.
