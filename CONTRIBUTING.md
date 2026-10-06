# Contributing to Rev4a

## Language rule

**100% English** — code, identifiers, comments, docs, UI strings, commit messages
(`AGENTS.md` §2.1). `npm run check:language` scans every tracked file for Italian words and
exits non-zero; CI runs it on every push to `main` and every pull request, and the release
workflow runs it again before publishing — Italian that reaches `main` is flagged at once and
cannot be published. The list is
deliberately conservative (it leaves out words that are English too, like `come` or `per`),
and a line carrying `lang-ok` is skipped when the Italian is the point of that line:

```ts
const sample = 'il messaggio di errore'; // lang-ok: the exact text a user reported
```

Git hooks are **not** installed automatically (nothing rewrites a contributor's git
config): enable the one in `.githooks/` with a single command per clone, and it checks what
you are committing before the commit exists:

```bash
git config core.hooksPath .githooks
```

---

## Documentation rule

**Every change to code must include a documentation update in the same commit.**
This applies to all contributors and all AI agents (Claude, Codex, DeepSeek, etc.).

If you are an AI agent working on this repo: read this file before closing any task, and verify that the relevant docs are up to date.

---

## Code → Doc mapping

| What you changed | What you must update |
|---|---|
| `app/api/gateway/**` | `docs/dev/GATEWAY.md` — Gateway provider sync, catalogue, sync outcome |
| `app/api/provider/v1/**` | `docs/dev/PROVIDERS.md` — proxy auth, model list, completions |
| `app/api/credentials/**` | `docs/dev/API-REFERENCE.md` — credential endpoints; `docs/ARCHITECTURE.md` — vault section |
| `app/gateway/**` | `docs/dev/GATEWAY.md` — Gateway UI, provider cards, overlay |
| `app/api/skills/**` | `docs/dev/API-REFERENCE.md` — skills list, save, promote endpoints |
| `app/api/**` (other) | `docs/dev/API-REFERENCE.md` — add/update endpoint description, params, response shape |
| `daemon.js` | (no dedicated doc — update `docs/ARCHITECTURE.md` if needed) |
| `lib/**` | `docs/ARCHITECTURE.md` and/or `docs/FRONTEND-ARCHITECTURE.md` |
| `app/**/page.tsx` or `app/**/components` | `docs/FRONTEND-ARCHITECTURE.md` — component tree, layout changes |
| `app/components/ui/**` (new/modified primitive) | `docs/FRONTEND-ARCHITECTURE.md` — UI catalog table |
| `app/globals.css` (tokens, visual language) | `docs/DESIGN-SYSTEM.md` — color tokens, shape rules |
| `scripts/**` | `docs/ARCHITECTURE.md` |
| `bin/**` (CLI, `rev4a serve` start-up) | `docs/REV4A.md` — Service Management; `README.md` — env vars |
| `server.js`, `terminal-ws-server.js`, `app/containers/terminal/**` | `docs/CONTAINER-TERMINAL.md`; `docs/dev/API-REFERENCE.md` — `GET /api/terminal-ws` |
| `instrumentation.ts` | `docs/dev/GATEWAY.md` — Sync Flow |
| `daemon.js` container sampling, `lib/docker-stats.js`, `lib/docker-socket-path.js`, `lib/container-metrics.ts`, `app/api/metrics/**`, `app/system/**`, `app/agents/ResourceSection.tsx` | `docs/ARCHITECTURE.md` — Container Consumption; `docs/dev/DATABASE.md` — Container consumption; `docs/dev/API-REFERENCE.md` — Metrics; `docs/FRONTEND-ARCHITECTURE.md` — System page, Agent resources; `docs/rag/` |
| `lib/model-pricing.ts` (prices, `PRICE_SCHEDULES`), `lib/price-schedule-sync.ts` | `docs/dev/GATEWAY.md` — Costs: OpenClaw prices every call |
| `daemon.js` cost collector, `lib/agent-costs.ts`, `lib/cost-reconciliation.ts`, `app/api/costs/**`, `app/costs/**`, `app/agents/CostSection.tsx` | `docs/ARCHITECTURE.md` — Agent Costs; `docs/dev/DATABASE.md` — Costs Database; `docs/dev/API-REFERENCE.md` — Stats & Costs; `docs/FRONTEND-ARCHITECTURE.md` — Costs page |
| `app/lib/**` | `docs/FRONTEND-ARCHITECTURE.md` |
| DB schema (migrations, new tables/columns) | `docs/dev/DATABASE.md` — schema section |
| Environment variables | `README.md` — Configuration table |
| Model catalogue change (new/removed models) | `models.config.json` — add/remove/rename models; `docs/dev/GATEWAY.md` — Model Catalogue section. The generated model details and the OpenRouter prices come from `npm run refresh:pricing` (`model-details.json` is never hand-edited); direct vendors' prices in `model-pricing.json`, cache rates included, are kept by hand from each vendor's pricing page (`docs/dev/GATEWAY.md` — Where the truth lives); the catalogue's `info` blocks (what no API publishes) are curated with `npm run info:suggest` and gated by `npm run info:verify` (`docs/dev/GATEWAY.md` — Curating an info block) |
| New feature (any) | `docs/rag/REV4A-OVERVIEW.md` and `docs/rag/WHAT-I-CAN-ANSWER.md` if PULSE should know about it |
| Auth / middleware | `docs/ARCHITECTURE.md` — security/auth section |
| `.github/workflows/ci.yml` | This file — Continuous integration section |
| `.github/workflows/release-publish.yml` | This file — Release process section |
| `.github/workflows/build-agent-image.yml` | This file — Agent image publishing section |
| `agent-templates/base-image/**` | `docs/REV4A.md` — Agent Templates (image contents, entrypoint behavior); `agent-templates/README.md` |
| `lib/agent-versions.json` (supported OpenClaw versions) | This file — Agent image publishing section; `docs/REV4A.md` — Base Image |
| `skills/**` (new or changed workspace skill) | `AGENTS.md` — §2.2a Workspace Skills table |

---

## Doc structure

```
docs/
├── dev/                     # Developer reference (technical depth)
│   ├── API-REFERENCE.md     # All /api/* endpoints
│   ├── GATEWAY.md           # Gateway page: provider sync and model catalogue
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

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main` and every pull request against
it, and it is the gate a change passes *before* it is merged:

1. `npm run check:language` — the 100% English rule (first, because it is the cheapest
   and it names the offending file and line)
2. `npm run typecheck` — `tsc --noEmit`
3. `npm run check:package-types` — pack the publishable files, require a sibling `.d.ts`
   for every CommonJS `.js`/`.mjs` in `lib/`, and typecheck the unpacked package under
   `node_modules/@flame0510/project-aether`
4. `npm run build` — the Next.js production build

A new push to the same branch cancels the run still in flight. The job's token is
read-only and not kept in `.git/config` after checkout. `npm ci` runs with
`REV4A_SKIP_POSTINSTALL_BUILD=1`: without it `bin/postinstall.js` would run a full
`next build` during the install — before the language check — and the build would then
run a second time. Outside CI, an unsuccessful post-install build fails the install.

The release workflow repeats the language, package-path typecheck and build gates on
purpose: it is the last gate before npm and must not assume CI has run on that commit.

The Docker stats parser also has focused tests (`node scripts/test-docker-stats.mjs`).
These gates do not replace a running-instance check for behavior changes.

`npm-shrinkwrap.json` is the published dependency lock for the globally installed app.
`package-lock.json` cannot be published by npm, even if named in `package.json`'s
`files`. Keep one lockfile: after changing dependencies, update the shrinkwrap with
`npm install` and verify the tarball with `npm run check:package-types`. The package
also pins Next.js directly, so a global install cannot silently select a newer minor
version. npm 10 and 11 honor the shrinkwrap; npm 12 ignores it, so its global dependency
tree is not fully locked. TypeScript and the `@types/*` packages used by `next build`
belong in `dependencies`: npm global installs omit `devDependencies`, and Next's
automatic type-package installer can select a different package manager and versions.

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
2. Installs, bumps `package.json` and `npm-shrinkwrap.json` to that version, checks the
   packed package under `node_modules`, and builds — a broken package or build cannot
   be published
3. Skips the publish (with a warning, not a failed run) if that version
   already exists on npm — safe to re-run a release
4. Publishes to npm with `NPM_TOKEN`
5. Commits the version bump back to `main` (`chore: align package.json with
   vX.Y.Z [skip ci]`) so the repo can never drift from what's on npm

`workflow_dispatch` is also available for a dry run (`dry_run: true`, the
default) — it runs the same steps up to `npm publish --dry-run` without
actually publishing, useful to sanity-check the pipeline itself.

**Do not** re-add a `push` trigger on `package.json` — that was the previous
setup, and it made every commit touching `package.json` attempt a publish,
racing against the `release` trigger and failing with `403 cannot publish
over the previously published version` more often than not.

---

## Agent image publishing

`.github/workflows/build-agent-image.yml` builds `agent-templates/base-image` on every
push to `main` that touches it, and on demand. The OpenClaw release comes from
`ARG OPENCLAW_VERSION` in the Dockerfile; a missing or malformed value fails the run
before anything is built.

It publishes to `ghcr.io/<repo>/openclaw-agent-base`:

- `:<version>` — the OpenClaw release; moves when the image is rebuilt for the same
  release
- `:<version>-<short sha>` — immutable, one per commit
- `:latest` — **only** when the workflow is run by hand with `promote_latest`

Rev4a itself never uses `:latest`: it pulls `:<version>` for the versions listed in
`lib/agent-versions.json` and keeps each as `openclaw-agent-base:<version>`. `:latest` is
for people running the image by hand. A new OpenClaw release migrates an agent's data
one way — the previous release refuses the migrated database — so moving `:latest` is a
deliberate step, never a side effect of merging a Dockerfile change.

**Rebuilds of a version reach installs only through a revision pin.** An install that
already has `openclaw-agent-base:<version>` never pulls `:<version>` again, so a rebuilt
image is invisible to it. After a rebuild is published, set `imageRevision` on that
version in `lib/agent-versions.json` to the `<short sha>` of the build (the suffix of its
immutable `:<version>-<short sha>` tag, also the image's `org.opencontainers.image.revision`
label) and release Rev4a. Installs then see the local image as outdated, the Agents page
banner offers the new build, and the download pulls `:<version>-<short sha>` and tags it
`openclaw-agent-base:<version>` and `openclaw-agent-base:<version>-rev.<short sha>`; a fresh
install gets the pinned build the same way. Running agents keep their image until they are
recreated or updated. A version without `imageRevision` is addressed by `:<version>` as before.

**Supporting a new OpenClaw version** is one change: bump `ARG OPENCLAW_VERSION` in the
Dockerfile and add the version at the top of `lib/agent-versions.json`, with the model
`input` values that release accepts. Keep the previous versions listed while agents
still run them.

```bash
gh workflow run build-agent-image.yml -f promote_latest=true
```

A manual run can also publish a version other than the Dockerfile's `ARG`, to backfill a
tag an older release never published (a rollback pulls that tag):

```bash
gh workflow run build-agent-image.yml -f version=2026.9.4
```

The input, when set, is used both as the build argument and as the tag; empty keeps the
Dockerfile ARG as the source of truth. The `:latest` tag still moves only with
`promote_latest`.

A release that predates the version ARG has only `:latest` on ghcr; a rollback still needs
its `:<version>` tag. `retag_latest_as` republishes the existing `:latest` under that tag
without building (the current Dockerfile may not be able to rebuild an older release —
its pinned plugin version may not exist):

```bash
gh workflow run build-agent-image.yml -f retag_latest_as=<version>
```

---

## Commit message format

```
<type>(<scope>): <short description>

Types: feat | fix | refactor | chore | docs
Scope: api | daemon | db | ui | deploy | auth | rag
```

Example: `feat(api): add /api/workspace endpoint` — and the same commit must touch `docs/dev/API-REFERENCE.md`.

Commits are attributed to the person who made the change. Do not add co-author trailers or
"generated with" footers for AI assistants or other tools — in commit messages or in pull
request descriptions — and keep tool-specific working folders out of the tree.

A `docs`-only commit is valid when fixing stale documentation without touching code.
