---
name: rev4a-deep-review
description: Deep anti-regression code review of a Rev4a branch or uncommitted working tree before commit or merge. Runs four parallel read-only reviewers (regressions, edge cases and failure modes, security, docs and language), then validates every finding against the code and, where possible, a running instance, and delivers one report in Italian. Use for "deep review", "deep code review", "anti-regression review", "review before commit".
---

# Rev4a Deep Code Review

Anti-regression review for the Rev4a repository. Most checks below trace to defects
that actually shipped or nearly shipped — see "Why these checks" at the end.

## When to use

- Before committing or merging work that touches agent lifecycle, the provider
  gateway, the model catalogue, Docker, the CLI (`bin/rev4a.js`) or architecture
- After refactoring a component other routes or pages depend on
- Any change above ~30 lines in `app/api/`, `lib/`, `bin/` or `agent-templates/`

## 1. Establish the scope

Reviewing the wrong thing is a real failure mode. Decide it explicitly.

- **Committed branch:** `git diff <base>...HEAD`, base usually `main`.
- **Uncommitted work:** `git diff HEAD` (staged and unstaged together) plus
  `git status --short` for untracked files. Review the **working tree**.
- **Stale index:** if a file appears in both `git diff --cached --name-only` and
  `git diff --name-only`, the index holds an older version of it. Say so in the
  report: a commit made from that index is not what was reviewed.
- Ignore untracked planning files excluded through `.git/info/exclude`.
- Read every changed file **in full**, not only the hunks.

Record the base, file count, lines changed, and whether a server built from this
tree is running.

## 2. Run four reviewers in parallel

Use the harness's sub-agent mechanism, with a strong model. Give each reviewer the
scope from step 1, a summary of what the change intends, the list of intentional
decisions (so trade-offs are not reported as bugs), known open items, and the
checklist for its lens.

Reviewers work in English and are **read-only**:
- no `npm run build` — it rewrites `.next` under a running server — and no
  starting or stopping `serve`;
- no state-changing requests: HTTP `GET` only against a running instance, and only
  read-only Docker commands (`ps`, `inspect`, `exec … cat`, `cp … -`);
- every finding carries `file:line`, evidence (quoted code or command output),
  severity, whether it was **introduced by this change or pre-existing**, and
  confidence.

### Lens A — Regressions

- Every removed or renamed export, route, response field, CSS class or env var:
  grep for remaining consumers in pages, `bin/`, `instrumentation.ts`, scripts and
  docs.
- Every changed response shape: find every caller — pages, the first-run wizard,
  the CLI — and check what it actually reads.
- Agent lifecycle end to end: create → readiness → config patch → sync; recreate;
  start and stop; delete. Mounts, labels, rollback on failure.
- Readiness works on the OpenClaw version the base image **pins**, not only the
  target version.
- Provider gateway: `models.providers.rev4a` written correctly, nothing outside it
  touched, applied without a gateway restart.
- Anything that used to succeed silently and now fails loudly: intended, but check
  every caller copes.

- **Upgrade safety (AGENTS.md §2.2c).** An install updated from the previous release: old databases
  and config, the first run on a large existing table, agents on older OpenClaw versions, rollback.

### Lens B — Edge cases and failure modes

- **Errors turned into empty values.** Every `catch` that returns `{}`, `[]`, `''`
  or `null`: who consumes it, and can that consumer write, or report success, on it?
- **Write after read.** A read-modify-write of a container or host file must abort
  when the read fails or returns empty.
- **Status versus outcome.** A route answering `ok` while side effects failed;
  callers that check only `status`.
- **Docker states.** Daemon down, paused or still starting — CLI present does not
  mean daemon ready. Containers stopped, created, paused, restarting. `docker ps`
  without `-a`. `docker exec` cannot reach a stopped container.
- **Partial failure** across several containers; retries or rollbacks that cannot
  restore consistency.
- **Timeouts.** A timed-out `docker exec` exits 0 and resolves with truncated
  output. `maxDuration` present and sufficient on long routes; blocking `execSync`
  in request paths.
- **Concurrency.** Two syncs or saves writing the same file at once; a stale
  in-flight request overwriting fresh state (AbortController, loading flags).
- **Client state frozen at mount** (`useEffect(…, [])`) for data another page changes.
- **Duplicate implementations of one rule** — they drift. Grep for a second copy
  of any check, loader or probe the change touches.
- **Empty and first-run states:** no provider keys, empty catalogue, zero agents,
  no `.env`.

### Lens C — Security

- **Shell strings.** Any `execSync`/`exec` whose command string contains dynamic
  input. Prefer argv via `execFileSync`/`spawn`; flag interpolation even when the
  value is "validated".
- **Authentication.** Every new or changed route calls `requireAuthJWT` or the
  gateway check. Secret comparison is constant-time. An absent or empty token can
  never match. A check that iterates a map of *different kinds* of secret — as in
  `provider-keys.json`, where `rev4a` is the gateway password and every other entry
  an upstream credential — is a finding.
- **Policy enforced where it acts.** Allowlists and catalogue rules must be enforced
  in the route that spends or acts (proxy, assistant), not only in the UI that
  lists the options.
- **Secrets in output.** Tokens or keys in logs, error messages, response bodies,
  argv (visible in the process table), or temp files (mode, cleanup).
- Auth-bypass flags (`dangerouslyDisableDeviceAuth`, `--allow-unconfigured`) and
  their compensating protection; Traefik labels for as long as Traefik support
  remains.

### Lens D — Docs and language

- Read all of `docs/` **including `docs/rag/`**, `README.md`, `CONTRIBUTING.md`,
  `AGENTS.md`, `agent-templates/README.md`, and **documentation embedded in code** —
  notably the page catalogue in `app/api/assistant/route.ts`, which the in-app
  assistant uses exactly like `docs/rag/`.
- For every changed behaviour: documented request and response shapes, env vars,
  paths, commands, defaults and numbers match the code.
- Features described that do not exist; examples using retired model ids or
  removed routes.
- Code comments that make factual claims — "verified", "only caller", counts,
  timings — are checked like any other claim.
- Structure: code fences balanced, relative `.md` links resolve.
- Language: zero Italian in code, comments, identifiers, UI strings, logs, docs and
  this skill. Report `file:line` and the text. Only the final report is in Italian.

## 3. Validate every finding (orchestrator — mandatory)

Reviewers are wrong often enough that nothing reaches the report unverified.

1. **File and line exist**, and the code there says what the finding claims.
2. **Introduced or pre-existing** — compare with `git show <base>:<file>`.
3. **Not a documented intentional decision.** If it is, note it, do not flag it.
4. **Severity calibrated** — can it happen in production; is there a safety net.
5. **Duplicates merged** across reviewers.
6. **Re-tested** wherever it can be exercised. Prefer a running instance to reading.
7. **Discarded findings listed** with the reason.

### Verifying against a running system

Reading has missed defects that a single request would have shown.

- **The OpenClaw gateway answers 200, with its web UI, for any unknown path.** A
  status code proves nothing about an endpoint existing; check the response body.
  Test on the OpenClaw version the image pins.
- Verification scripts **fail fast** when the initial state is unreadable or empty,
  and assert the test objects exist before asserting anything about them. Two empty
  reads compare as "unchanged".
- **zsh does not word-split** an unquoted `$VAR`: `for c in $LIST` runs once with
  the whole string. Run multi-step checks in explicit `bash`.
- With Docker stopped every container read is empty. Check `docker info` first.
- Never mutate real agents. Use throwaway containers — labelled, never started —
  and remove them and their volumes afterwards; confirm the cleanup. A fresh named
  volume mounted at `/root` inherits the base image's default `openclaw.json`.
- State-changing checks (sync, toggles) are done only by the orchestrator,
  reversibly, restoring files byte-for-byte.

## 4. Report

One unified report **in Italian** for the maintainer. One line for the problem, one for
the fix. No wall of text.

```
## Deep Review — <branch or "working tree">
Scope: <base> · <n> files · +<a> −<d> · stale index: yes/no

### CRITICAL
- file:line — problem → fix  (introduced | pre-existing)

### HIGH
### MEDIUM
### LOW

### Verified OK
- what was checked and confirmed, and how (read / live test)

### Discarded
- claim → why (line does not match, intentional decision, not reproducible, …)

| Severity | Count |
|---|---|
| CRITICAL | n |
| HIGH | n |
| MEDIUM | n |
| LOW | n |
| Discarded | n |
```

## Rules

- **NEVER commit or push without the maintainer's explicit approval.**
- Severity guide: data loss or silent corruption → CRITICAL; broken flow, auth
  weakness, missing `maxDuration` on a long route, Italian in code → HIGH;
  doc/code divergence, Italian in docs → MEDIUM; dead code, cosmetic → LOW.
- Every finding says whether it was introduced or pre-existing.
- Always flag files committed by mistake: review artifacts, backups, logs, `.env`.

## Why these checks

Found on branch `pre-upgrade-hardening`, September 2026:

- A readiness probe required `"started"` from `/startupz`, which OpenClaw 2026.7.1-2
  does not have; its gateway answered 200 with HTML, and agent creation failed after
  60 seconds. Caught by use, not by reading.
- The config sync turned a failed read into `{}` and wrote it back, replacing an
  agent's whole `openclaw.json` with the provider block.
- A model toggle made while Docker was stopped synced to no container and reported
  success; the Gateway page never read the sync outcome.
- The gateway proxy accepted any upstream provider key as its own password.
- Unchecking a model hid it from every picker but the proxy and assistant still
  served it.
- Four model-catalogue readers, three readiness probes and two auth checks had
  drifted apart.
- The chat panel's model list was loaded once at mount and never refreshed.
- `docker ps` without `-a` left stopped agents with an old catalogue.
- `serve` treated "docker CLI installed" as "Docker ready"; it worked at boot only
  because `docker.socket` happened to hold the first call.
- `docs/rag/` and the assistant's in-code page catalogue described features that do
  not exist.
- Verification scripts reported false passes through zsh word splitting and
  empty-versus-empty comparisons.
