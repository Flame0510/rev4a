# Contributing to Rev4a

## Documentation rule

**Every change to code must include a documentation update in the same commit.**
This applies to all contributors and all AI agents (Claude, Codex, DeepSeek, etc.).

If you are an AI agent working on this repo: read this file before closing any task, and verify that the relevant docs are up to date.

---

## Code → Doc mapping

| What you changed | What you must update |
|---|---|
| `app/api/gateway/**` | `docs/dev/GATEWAY.md` — Gateway provider sync, agent model config |
| `app/api/provider/v1/**` | `docs/dev/PROVIDERS.md` — proxy auth, model list, completions |
| `app/api/vault/**` | `docs/dev/PROVIDERS.md` — key management section |
| `app/gateway/**` | `docs/dev/GATEWAY.md` — Gateway UI, overlay, polling |
| `app/api/skills/**` | `docs/dev/API-REFERENCE.md` — skills list, save, promote endpoints |
| `app/api/**` (other) | `docs/dev/API-REFERENCE.md` — add/update endpoint description, params, response shape |
| `daemon.js` | (no dedicated doc — update `docs/ARCHITECTURE.md` if needed) |
| `lib/**` | `docs/ARCHITECTURE.md` and/or `docs/FRONTEND-ARCHITECTURE.md` |
| `app/**/page.tsx` or `app/**/components` | `docs/FRONTEND-ARCHITECTURE.md` — component tree, layout changes |
| `app/components/ui/**` (new/modified primitive) | `docs/FRONTEND-ARCHITECTURE.md` — UI catalog table |
| `app/globals.css` (tokens, visual language) | `docs/DESIGN-SYSTEM.md` — color tokens, shape rules |
| `scripts/**` | `docs/ARCHITECTURE.md` |
| DB schema (migrations, new tables/columns) | `docs/dev/DATABASE.md` — schema section |
| Environment variables | `README.md` — Configuration table |
| Model catalogue change (new/removed models) | `models.config.json` — add/remove/rename models; `docs/dev/GATEWAY.md` — Model Catalogue section |
| New feature (any) | `docs/rag/REV4A-OVERVIEW.md` and `docs/rag/WHAT-I-CAN-ANSWER.md` if PULSE should know about it |
| Auth / middleware | `docs/ARCHITECTURE.md` — security/auth section |
| `.github/workflows/release-publish.yml` | This file — Release process section |

---

## Doc structure

```
docs/
├── dev/                     # Developer reference (technical depth)
│   ├── API-REFERENCE.md     # All /api/* endpoints
│   ├── GATEWAY.md           # Gateway page: provider sync, agent model config
│   ├── PROVIDERS.md         # Provider key management, proxy auth
│   ├── WORKSPACE.md         # Workspace API file explorer
│   ├── DATABASE.md          # SQLite schema, WAL, backup
├── rag/                     # PULSE knowledge base (plain language)
│   ├── REV4A-OVERVIEW.md  # What Rev4a is and does
│   ├── GLOSSARY.md          # Key terms
│   ├── WHAT-I-CAN-ANSWER.md # PULSE capability scope
│   └── DATA-FRESHNESS.md    # Update intervals and data latency
├── ARCHITECTURE.md          # High-level architecture diagram/summary
├── CONTAINER-TERMINAL.md    # Terminal WebSocket PTY implementation
├── DESIGN-SYSTEM.md         # Design tokens, colors, typography
├── FRONTEND-ARCHITECTURE.md # Component layers and design system
├── REV4A.md               # Operational docs
└── README.md               # Project overview, setup, configuration
```

---

## What "update the doc" means

- **New endpoint** → add a full entry in `api-reference.md` (method, path, auth, params, response, errors)
- **Changed behavior** → update the relevant section; don't append a changelog note, rewrite the truth
- **Removed feature** → delete it from the doc; no "deprecated" stubs
- **New config variable** → add it to the README table and wherever it's used in setup guides
- **New page/component** → add it to `frontend-architecture.md` with its responsibility

Keep docs accurate and current, not historical. No changelog entries inside doc files.

---

## Release process

Publishing to npm is driven entirely by the GitHub release tag — never by
pushing to `package.json`.

```bash
gh release create v1.2.0 --target main --title "v1.2.0" --notes "..."
```

This triggers `.github/workflows/release-publish.yml`, which:

1. Checks out the tag and derives the version from it (validated as semver — a
   malformed tag like `v1.2` fails before publishing anything)
2. Installs, bumps `package.json` to that version, builds — the build is a
   gate, a broken build never gets published
3. Skips the publish (with a warning, not a failed run) if that version
   already exists on npm — safe to re-run a release
4. Publishes to npm with `NPM_TOKEN`
5. Commits the version bump back to `main` (`chore: allinea package.json a
   vX.Y.Z [skip ci]`) so the repo can never drift from what's on npm

`workflow_dispatch` is also available for a dry run (`dry_run: true`, the
default) — it runs the same steps up to `npm publish --dry-run` without
actually publishing, useful to sanity-check the pipeline itself.

**Do not** re-add a `push` trigger on `package.json` — that was the previous
setup, and it made every commit touching `package.json` attempt a publish,
racing against the `release` trigger and failing with `403 cannot publish
over the previously published version` more often than not.

---

## Commit message format

```
<type>(<scope>): <short description>

Types: feat | fix | refactor | chore | docs
Scope: api | daemon | db | ui | deploy | auth | rag
```

Example: `feat(api): add /api/workspace endpoint` — and the same commit must touch `docs/dev/api-reference.md`.

A `docs`-only commit is valid when fixing stale documentation without touching code.
