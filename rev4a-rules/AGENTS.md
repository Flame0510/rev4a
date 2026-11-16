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
  are managed through the Rev4a dashboard — not by editing config files directly
  (one narrow exception: the list in "Tools Switched Off on Claude Runs" below).
  Rev4a may apply configuration changes at any time.
- **Rev4a may restart your gateway** for updates or configuration changes.
  This is normal operation and does not indicate a problem.

## Credentials

Credentials are provided by OpenClaw: as environment variables, through the GitHub
identity, or through the Vercel CLI's own login. If one you need is missing, it is switched
on from Rev4a's Credentials page. Never ask for or print a token.

## Memory

Your container may have a memory limit: read `/sys/fs/cgroup/memory.max` on cgroup v2 — if that file is missing, the limit is unknown (`max` means none).
Do not load very large files or datasets into memory at once; stream them. A process that
ends with exit code 137 was most likely killed for lack of memory: tell the user instead of
retrying it in a loop.

## Tools Switched Off on Claude Runs

On Claude runs (the Claude plan through Claude Code) some tools are off to save tokens. The
list is `tools.byProvider.anthropic.deny`: read it with
`openclaw config get tools.byProvider.anthropic.deny`. Other models are unaffected.

This list is the one part of `openclaw.json` you may change yourself (the exception to the
boundary above). To switch a tool on, write the list back without that name; a patch replaces
the whole array:

`printf '%s' '{"tools":{"byProvider":{"anthropic":{"deny":[...the others...]}}}}' | openclaw config patch --stdin`

It applies from your next turn, with no restart. To switch every tool on, write `[]`, never `null`
(null deletes the list, and Rev4a writes its default back at the next dashboard start). Tell the user what you switched on and why.
Switch it off again when the task is done, unless you will need it again soon. Do not add tools
you use regularly to the list, and do not touch any other key.

## Credentials on the ChatGPT Subscription Runtime (Codex)

Credentials reach commands run through OpenClaw (`gateway_exec`), not the native Codex
shell. If a tool reports it is not authenticated, try it through `gateway_exec` before
telling the user the credential is missing.

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

## What Survives a Container Recreate

Only `/root` (your volume) survives when Rev4a recreates your container or updates
OpenClaw. Everything outside `/root` is lost, including programs you installed there.
A plain restart keeps everything; the difference only shows after a recreate.

**First check whether your image records apt installs:** `readlink /usr/local/sbin/apt-get`
prints `rev4a-apt` on images built since 2026-10-06. If it prints nothing, your image is
older: nothing is recorded yet, and anything you install outside `/root` will be lost at the
next recreate — tell the user when a tool you depend on lives there.

On an image that records:
- **`apt-get install` / `apt install` is recorded and installed again automatically**
  after a recreate (in the background, a few minutes after start), together with the apt
  sources you added under `/etc/apt/` and the key files those sources name with
  `signed-by`. Only the packages you name are recorded, not their dependencies. To stop it,
  remove the package with `apt-get remove` or `apt-get purge`. The outcome of the last
  reinstall is in `/root/.rev4a/packages-status.json`.
- **Not recorded:** packages installed **before** your image recorded (reinstall them once),
  local `.deb` files (`apt install ./x.deb`, `dpkg -i`), and `/usr/bin/apt-get` called by
  its full path.
- **Anything installed another way is lost** unless it lives under `/root`: an
  `npm install -g`, a downloaded binary, a language runtime. Keep such tools under
  `/root/.local`, for example `npm install -g --prefix /root/.local <package>`, and copy a
  downloaded binary to `/root/.local/bin` (on `PATH` in images that record apt installs; on
  older ones call it by its full path).
