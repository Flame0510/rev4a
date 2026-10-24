# AGENTS.md — Agent Guidelines for Rev4a

> **Purpose:** A single entry point for any AI agent (or human contributor) working
> on this repository. Read this first, then follow the docs it references.
>
> **Status:** Active — `main` branch
> **Last updated:** 2026-10-05

---

## 1. First Contact

If you are an AI agent arriving on this repo for the first time:

1. Read this file completely.
2. Read `README.md` for project overview, features, and quick start.
3. Read `docs/REV4A.md` for app-level features, pages, and navigation.
4. Read `docs/ARCHITECTURE.md` for system architecture and component layout.
5. Read `docs/dev/API-REFERENCE.md` for API endpoints.
6. Read `docs/dev/GATEWAY.md` for provider sync and agent model configuration.
7. Read `docs/dev/PROVIDERS.md` for key management and the Rev4a provider proxy.
8. Read `docs/FRONTEND-ARCHITECTURE.md` for frontend structure and decisions.
9. Read `docs/CONTAINER-TERMINAL.md` for terminal WebSocket implementation.
10. Read `docs/dev/DATABASE.md` for SQLite schema and storage notes.
11. Read `docs/dev/WORKSPACE.md` for workspace file explorer and editor.
12. Read `docs/DESIGN-SYSTEM.md` for design tokens and visual standards.

> **Additional resources:**
> - `docs/rag/` — LLM-facing knowledge base for RAG-powered responses
> - `agent-templates/` — reusable agent protocols for Atlas, Argus, Prometheus, Custom
> - `skills/` — agent skills for this workspace (see §2.2a below)
>
> **Rule:** After reading, if a file is stale (wrong dates, missing info), update it.
> Do not assume docs are authoritative — verify against code.
>
> **Key source files (centralized logic):**
> - `lib/agent-setup.ts` — single source of truth for Rev4a volumes + runtime config
> - `rev4a-rules/AGENTS.md` — system rules injected into every agent session via hook

---

## 2. Repository Rules

### 2.1 Language

**100% English.** Everything:
- Code (variables, comments, functions, types)
- Documentation (`.md` files, code comments)
- Commit messages
- Error messages, UI strings, logs

No Italian, no other languages in code or docs.

`npm run check:language` scans every tracked file and exits non-zero on an Italian word;
CI runs it on every push to `main` and every pull request, and the release workflow runs
it again before publishing — Italian that reaches `main` is flagged at once and cannot be
published. It is also shipped as an
optional git hook: `git config core.hooksPath .githooks` once per clone checks only what
you are committing. A line carrying `lang-ok` is skipped when the Italian is the point of
that line (see `CONTRIBUTING.md` § Language rule).

`check:language` is a **word list**, not a language detector — it only catches the
words it knows, and it never reads the commit message (it scans tracked/staged file
content, `git ls-files` / `git diff --name-only`). Twice already an agent doing the
English pass on its own diff missed Italian the script would later catch (commits
`c7654c0`, `7b586f6`), and one Italian commit message (`0d9814b`) shipped because
nothing checks that at all. Before committing, run the script for the words, then
reread the diff yourself for Italian syntax made of words the list leaves out on
purpose (`come`, `per`, `non`, `la`…) — and reread the commit message, which the
script will never see.

### 2.2 Code Style

- **TypeScript strict mode** — `tsconfig.json` has `strict: true`
- **Next.js App Router** — `app/` directory, not `pages/`
- **React Server Components** by default; use `'use client'` only when necessary
- **CSS** — inline styles or `globals.css` tokens (CSS variables). No CSS modules, no Tailwind.
- **SQLite** — via `better-sqlite3`, synchronous API
- **Systemd** — production process management via `rev4a.service`
- **Python NOT allowed** — no Python scripts, no Jupyter, no notebooks in this repo
- **CommonJS in `lib/` needs types** — every `.js` or `.mjs` there must have a sibling
  `.d.ts`. The npm tarball is installed under `node_modules`, where TypeScript treats
  these imports as package modules and cannot infer their types from `allowJs` alone.
  `npm run check:package-types` checks both the packed files and that resolution path.
- **Global builds need runtime dependencies** — npm global installs omit
  `devDependencies`; keep TypeScript and the `@types/*` packages used by `next build`
  in `dependencies`. The published shrinkwrap locks their installed versions on npm 10
  and 11; npm 12 ignores it.

### 2.2a Workspace Skills

This repository includes agent skills in `skills/` (workspace-level, per
[OpenClaw Skills docs](https://docs.openclaw.ai/tools/skills)).
Skills are committed to the repo so any agent working on this project has
access to them.

| Skill | Description |
|---|---|
| `rev4a-deep-review` | Deep anti-regression review: 4 parallel read-only reviewers (regressions, failure modes, security, docs & language), every finding validated against code and a running instance |

---

### 2.2b Design System (UI)

Rev4a has a shared UI design system. **Read `docs/DESIGN-SYSTEM.md` and `docs/FRONTEND-ARCHITECTURE.md` before writing any UI code.**

1. **Use shared primitives.** All UI lives in `app/components/ui/`. `Button`, `Input`, `Select`, `Switch`, `Modal`, `Toast`, `Tabs`, `ItemList`, `FilterBar`, `PropertyList`, `TemplateOption`, `MemoryLimitPicker`, `LoadingSpinner`, `Pill`, `Metric`, `StatusCard`, `Meter`, `TimeSeriesChart`, `Accordion`, `Surface`, `Page`. Never replicate them.
2. **No inline styles on interactive elements.** Buttons, inputs, selects use the shared component. Only layout wrappers use inline style.
3. **Square visual language.** `border-radius: 0`, no shadows, flat design. The violet accent (`--color-accent-500`) only.
4. **Interactive elements must be `<button type="button">`.** Not `<span onClick>`, not `<div onClick>`.
5. **100% English.** UI labels, errors, aria-labels. No Italian.
6. **New UI component?** Add it to `app/components/ui/`, export from `index.ts`, document in `docs/FRONTEND-ARCHITECTURE.md`.
7. **No one-off card styles.** If a new page needs a visual pattern, extract a component instead of duplicating markup.
8. **Every on/off control is a `Switch`.** Never a styled button, a checkbox or a "Switch on / Switch off" text button for a persistent enabled/disabled state; an action that is not a state (Delete, Retry, Sync) stays a `Button`.
9. **Every async action button MUST show loading state.** Use the `Button` component's `loading` prop. Disable the button and all sibling action buttons during the operation. Every approve, revoke, delete, connect, restart, or similar action must have its own dedicated loading state (never share a generic `loading` boolean across unrelated buttons — a single state holding a *key* that identifies the running action satisfies this and is the pattern to use; see rules 6a-6c in `docs/FRONTEND-ARCHITECTURE.md`). The button text should change to reflect the action: "Approving…", "Revoking…", "Restarting…", etc.
10. **Prevent race conditions on repeated fetch calls.** When a fetch can be triggered while a previous call is still in flight (polling intervals, tab switches, user double-click, modal open/close), use `AbortController` via a `useRef` to cancel the stale request before starting a new one. Pattern: `abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller; fetch(url, { signal: controller.signal })`. Check `e?.name !== 'AbortError'` in catch to silence abort noise. This applies especially to: polling logic, data re-fetches after mutations, and any fetch triggered by user interaction that could fire multiple times before resolution.

### 2.2c Upgrade Safety (since 2026-10-05)

Rev4a is open source: people install it with npm and update it from the dashboard banner, and most of
them cannot fix a broken install by hand. **An update must never break an existing install.** This replaces
the earlier "no backward compatibility" rule; it applies to every change made from 2026-10-05 on (code
written before that date is not audited retroactively, but anything touched again must meet it).

For every change, before it is called done, answer in the PR or the report:

1. **Existing data.** What happens to databases, config files, `.env`, `provider-keys.json` and agent
   volumes written by the previous releases? Schema changes are additive and idempotent
   (`CREATE … IF NOT EXISTS`, `ADD COLUMN` guarded); nothing is dropped or rewritten without a migration
   that is safe to run twice and on a half-migrated file.
2. **First run after the update.** Large existing tables, missing files, old defaults, a daemon started
   before the dashboard: the first pass must not block, crash or take minutes.
3. **Older agents.** Agents on an older OpenClaw version keep working (at least: listed, started, stopped,
   Control UI reachable). A feature they cannot support is hidden or explained, not broken.
4. **Behaviour users will notice.** Data that is now deleted, renamed or moved; a changed default; a new
   requirement. It goes in the release notes.
5. **Rollback.** Can the previous version still run on the data this version wrote? If not, say so and
   make the update take a backup first.

Reviewers and checkers check these five points like any other defect. A missing answer is a finding.

**A fix must also repair installs already hit.** Operators update from the banner and cannot fix
their hosts by hand, and nobody can do it for them. When a released defect left a host in a bad
state (wrong tags, stale files, a missed migration), the fix ships with an idempotent repair that
runs on its own after the update — at startup or in the daemon — and is logged. Example: 1.13.1
re-tags agent images that lost their tags in 1.13.0, so the next recreate picks the right build.

### 2.3 Documentation-First Workflow

**Before every commit, complete this checklist:**

- [ ] Are all design decisions documented? If you changed something, write or update the relevant `.md` file.
- [ ] Does `docs/ARCHITECTURE.md` still reflect reality? Update it if your change affects architecture.
- [ ] Does `docs/CONTAINER-TERMINAL.md` need updating? (Terminal-related changes.)
- [ ] Does `docs/FRONTEND-ARCHITECTURE.md` need updating? (Frontend changes.)
- [ ] Does `docs/DESIGN-SYSTEM.md` need updating? (Design token changes.)
- [ ] Does `docs/REV4A.md` need updating? (App-level features, pages, navigation.)
- [ ] Does `docs/dev/API-REFERENCE.md` need updating? (New/modified API routes.)
- [ ] Does `docs/dev/DATABASE.md` need updating? (Schema changes.)
- [ ] Does `docs/dev/GATEWAY.md` need updating? (Provider/agent config changes.)
- [ ] Does `docs/dev/PROVIDERS.md` need updating? (Auth or proxy changes.)
- [ ] Does `docs/dev/WORKSPACE.md` need updating? (Workspace API changes.)
- [ ] Does `docs/rag/` need updating? (RAG knowledge base changes.)
- [ ] Does `agent-templates/README.md` need updating? (New/updated agent protocols.)
- [ ] Does `AGENTS.md` need updating? (New rules or conventions.)
- [ ] Are there new dependencies? Add them to the relevant docs.
- [ ] Does `README.md` need updating? (New features, changed setup.)
- [ ] Answered the five upgrade-safety questions (§2.2c) for this change?
- [ ] Ran `npm run precheck` (tests, language, typecheck, package types, secret scan)? A new
      `scripts/test-*` file is picked up by `npm test` on its own.
- [ ] Ran `npm run check:language`? Then reread the diff and the commit message
      yourself — the script is a word list, it misses Italian syntax and never
      reads the message (see §2.1).
- [ ] Ran `npm run check:package-types`? It checks the npm tarball under `node_modules`,
      where a local repository build cannot catch missing CommonJS declarations.

**Guideline:** Write docs while you implement, not after. A change without
documentation is incomplete.

### 2.4 Commit & Push Policy

- **No commit/push without confirmation** — ask the user before staging and pushing
- **Commit only when work is validated** — trunk-based development: commit at the end
- **Descriptive commit messages** — explain the *why*, not just the *what*
- **Single logical commit per change** — squash if needed
- **Authorship stays with the maintainer** — no co-author trailers, "generated with" footers or signatures for AI assistants or other tools, in commit messages or pull request descriptions; tool-specific working folders stay out of the tree (list them in `.git/info/exclude`)
- **Tag every version** — when a new version is released (bump in `package.json`), create and push the corresponding git tag: `git tag -a vX.Y.Z -m "vX.Y.Z: <brief>" && git push origin vX.Y.Z`. Never skip tagging — the version in code and the git tag must always stay in sync.

### 2.5 Secrets & Safety

- **Never commit secrets** — `.env`, tokens, passwords, API keys. Use environment variables.
- **Destructive operations** — `rm -rf`, `docker rm`, `systemctl stop` → ask first. Trash over delete.
- **Host safety** — Docker volumes named `rev4a-*` or `agent-*` hold users' data. Never run
  `docker volume prune --all`, `docker system prune --volumes` or `docker volume rm` on them, in code,
  scripts, docs or by hand. The only exceptions: the one volume a user explicitly asked to delete (deleting
  an agent removes its own `agent-<id>-data` volume; Delete on an orphan volume in System, without `-f`), the
  volume a failed create made itself in that same request, and Rev4a's own backups migration, which removes the
  legacy `rev4a-backups` volume once it is empty and no container uses it. Agent backups are plain files in
  `<REV4A_DATA>/backups` (`lib/backups.ts`): list, check and delete them with `fs`, never with a helper
  container; containers only write an archive and restore one.
- **Sensitive files** (`.env`, `SYSTEM.md`, `start.sh`, debug/proxy endpoints) are `untracked` — never pushed.

---

## 3. Architecture Overview (Quick Reference)

```
domain:      <your-rev4a-domain> (port 3740, behind the reverse proxy of your choice)
stack:       Next.js 16 + React 19 + TypeScript + SQLite + systemd
processes:   one systemd unit, rev4a.service, runs `rev4a serve`, which supervises
             server.js (Next.js + the terminal upgrade, port 3740), the session daemon and
             the terminal server (127.0.0.1:3741)
repo:        github.com/Flame0510/rev4a.git (branch main)
language:    100% English
```

### Key Docs

| File | What it covers |
|---|---|
| `docs/ARCHITECTURE.md` | System architecture, multi-container vision, component design |
| `docs/CONTAINER-TERMINAL.md` | Container terminal: server.js upgrade, security, sessions, xterm.js client |
| `docs/FRONTEND-ARCHITECTURE.md` | Frontend structure, component tree, mobile breakpoints |
| `docs/REV4A.md` | App-level features, pages, navigation |
| `docs/DESIGN-SYSTEM.md` | Design tokens, colors, typography |
| `docs/dev/API-REFERENCE.md` | API route documentation |
| `docs/dev/DATABASE.md` | SQLite schema, tables, relations |
| `docs/dev/GATEWAY.md` | Gateway page: provider sync, agent model config, UI |
| `docs/dev/PROVIDERS.md` | Provider key management and Rev4a proxy gateway |
| `docs/dev/WORKSPACE.md` | Workspace API file explorer and editor |
| `docs/rag/` | LLM-facing knowledge base for RAG-powered responses |

---

## 4. Agent Workflow

When the user asks you to do something on this repository:

1. **Understand the request** — if unclear, ask
2. **Check relevant docs** — understand existing design before changing it
3. **Implement** — code changes
4. **Update docs** — reflect changes in the appropriate `.md` files
5. **Ask for commit approval** — never push without asking
6. **Commit & push** — only after user confirms

### If you have host access (operating an install)

- On a Linux host Rev4a runs as the `rev4a` systemd service
- Use `sudo systemctl restart rev4a.service` after builds
- Use `sudo journalctl -u rev4a -f` to view the logs (Next.js, daemon and terminal share the unit)
- Use `npm run build` for Next.js builds
- Never expose secrets in responses
- Agent data volumes (`agent-*-data`) are listed, never auto-deleted, when no container uses them (System page, `/api/system/orphan-volumes`); the only automatic removal is the volume a failed create made itself

---

## 5. Common Commands

```bash
npm run dev          # Start Next.js dev server
npm run build        # Build for production
npm run typecheck    # tsc --noEmit (CI gate)
npm run check:package-types  # Typecheck the packed app under node_modules
npm test             # Every scripts/test-* in its own process (CI gate)
npm run check:ui     # Browser checks against a RUNNING instance (REV4A_BASE_URL); not in CI
npm run precheck     # Before a PR: tests + language + typecheck + package types + secret scan
npm run check:language  # 100% English rule (CI gate)
rev4a serve        # Start all services (dashboard + daemon + terminal)
npm start            # Same as rev4a serve
sudo systemctl status rev4a.service  # Production: check running services
sudo journalctl -u rev4a -f         # Production: logs of all three processes
```

---

## 6. Glossary

| Term | Meaning |
|---|---|
| **Rev4a** | This project — monitoring dashboard + orchestrator |
| **PULSE** | Embedded AI assistant in the UI |
| **OpenClaw** | The agent runtime that Rev4a monitors |
| **Traefik** | The reverse proxy the original deployment used; Rev4a works behind any proxy, or none |
| **node-pty** | Node.js PTY library for interactive terminal sessions |
| **AGENT_ID** | Docker label used to identify agent containers |
