# Olympus Deep Code Review

Specialized deep code review for the Olympus VPS repository.
Trigger phrases: "deep review", "anti-regression code review", "review PR", "deep code review".

## When to use

- PR or branch about to be merged into main
- Changes touching agent creation (route.ts), Dockerfile, setup, architecture
- After refactoring critical components (provider gateway, container creation, shared volumes)
- Pre-commit verification when the diff exceeds ~30 lines

## How it works

1. **Read the diff** — `git diff main...branch` or `git diff target...branch`
2. **Read changed files in full** (not just the diff) for full context
3. **Spawn 4 sub-agents in parallel** (default `deepseek/deepseek-v4-pro`, 300s timeout):
   - **Regressions** — what breaks from things that already work?
   - **Edge cases** — null inputs, timeouts, permissions, race conditions, orphan containers
   - **Doc coherence** — ALL documentation vs code, not just ARCHITECTURE.md
   - **Security** — injection, token exposure, shell quoting, permissions
4. **Sub-agents work in English** (lower token consumption, higher accuracy).
5. **CRITICAL — Validate every sub-agent finding before merging.** Once all 4 reports arrive, the orchestrator MUST:
   - **Cross-check each finding against the actual code** — read the referenced file at the reported line, verify the claim is real.
   - **Flag hallucinations** — if a sub-agent claims something that doesn't exist (wrong line number, invented code, fictional edge case), mark it as ❌ ALLUCINATION and discard it.
   - **Verify severity** — sub-agents often inflate severity. Downgrade if the impact is theoretical, cosmetic, or already handled.
   - **Merge duplicates** — same issue reported by multiple sub-agents → keep one, note the overlap.
   - **Re-test borderline claims** — if a finding sounds plausible but you can't confirm from code alone, test it (run the command, check the file exists, etc.).
   - **Language audit (🇬🇧) — scan ALL changed files for Italian text.** Any Italian word, comment, string, error message, variable name, or UI label in source code, docs, or config files is a violation. Olympus is 100% English. Flag every occurrence with file:line and the Italian text found. Severity: **HIGH** (code/comments), **MEDIUM** (docs).
   - This validation step is **mandatory** and must be done before producing the final report. Do NOT trust sub-agent output blindly.
6. **The orchestrator produces a single unified report** with the validated, deduplicated, severity-adjusted findings **in Italian** for the user. The report must include a section listing discarded allucinations with a brief reason for each.

## Checklist per sub-agent

### 🔁 Regressions
| Check |
|---|
| Does `docker run` in the wizard have all required mounts? |
| `waitForContainerReady` timeout adequate? Rollback on failure? |
| Does `syncAgent` / `buildOlympusProviderConfig` work? Is `models.providers.olympus` written correctly? |
| Does `openclaw gateway restart` preserve existing flags? |
| Does `config patch --stdin` overwrite manually configured arrays? |
| Does `extraDirs` survive all write paths (create, recreate, sync)? |
| Does `entrypoint.sh` overwrite critical config sections? |
| Are systemd `WorkingDirectory` and `Environment` correct after changes? |
| Was any removed function referenced elsewhere in the codebase? |

### 🔀 Edge cases
| Check |
|---|
| `buildOlympusProviderConfig()` with empty `provider-keys.json` or missing `olympus` key? |
| `models.config.json` missing or corrupted? |
| Template copy: workspace doesn't exist yet, does `test -f` fail cleanly? |
| RECREATE: `openclaw.json` not yet generated when lightweight patch starts? |
| RECREATE: lightweight patch in catch → container stays running without provider? |
| CREATE: `docker rm -f` on failed health check — volume persists (OK)? |
| Parallel CREATEs: race condition on `fs.mkdirSync` of shared dirs? |
| `docker run` time > 60s → `execSync` timeout killed, orphan container? |
| Container names with special characters: `shellQuote` applied everywhere? |
| What happens when `buildOlympusProviderConfig().apiKey` is empty string? |

### 📚 Doc coherence
**Mandatory: read ALL `.md` files in `docs/`, `agent-templates/README.md`, and any other referenced doc files.**

| Check |
|---|
| Does every documented mount path match the code exactly? (`docker run`, `docker cp`, entrypoint, Dockerfile) |
| Does every documented `openclaw` command exist in the installed version? |
| Is every documented env var used in code and vice versa? |
| Does every documented `docker run` flag match the code? |
| Do status tables (🟢/🔴) reflect the actual feature state? |
| Do referenced `.md` files still exist? Are internal links not broken? |
| Are naming conventions (AGENT_ID vs container name vs hostname) consistent everywhere? |
| Do documented OpenClaw version, Node version, base image match the Dockerfile? |
| Do npm packages installed in the image match the docs? |
| Are code comments and docstrings in English, not outdated? |
| Are documented end-to-end flows (CREATE → RECREATE → DELETE) still accurate? |
| Does the documentation reference scripts or files that no longer exist? |

### 🔒 Security
| Check |
|---|
| Does every `execSync` with dynamic input have `shellQuote` applied? |
| `docker exec -i ... sh -c 'cat > ...'` with JSON input: is the path quoted? |
| Are tokens/auth exposed in error messages, logs, or response bodies? |
| Are environment variables containing secrets logged? (`console.log`, `console.warn`) |
| Are `--allow-unconfigured` or auth-bypass flags still active after setup? |
| Are sensitive files referenced in web-accessible paths? |
| Is `dangerouslyDisableDeviceAuth` justified by alternative protection (token)? |
| Do Traefik labels generate correct routing rules without exposing internals? |

## Olympus-specific checks

Always verify these areas in addition to generic checks:

| Area | What to check |
|---|---|
| **Container creation** | Does `docker run` in the wizard have all required mounts? Are shared volumes mounted? Is `waitForContainerReady` timeout adequate? Is there rollback on failure? |
| **Provider gateway** | Does `syncAgent` work with the new changes? Is `models.providers.olympus` written correctly? Does `openclaw gateway restart` preserve flags? |
| **Config patch** | Does `config patch --stdin` replace arrays? Could it overwrite user-configured keys? Does `extraDirs` survive all write paths? |
| **Entrypoint** | Does `entrypoint.sh` overwrite critical config? Does token auth work? |
| **Mount paths** | Do mount paths in code match the documentation? Are internal container paths (`/root` vs `/data`) consistent? |
| **Setup flow** | Does `olympus.sh` create all directories before they're needed? Is function ordering correct? |
| **Systemd** | Does the olympus service have correct `WorkingDirectory` and `Environment`? |
| **Traefik** | Are labels generated correctly? Is the domain consistent? |
| **Mobile scroll** | Do pages with long lists have `minHeight: '100dvh'` and `overflowY: 'auto'`? |
| **Performance** | Is `maxDuration` declared in every route that does `docker run` or long `execSync`? Is the value sufficient for worst case? Can blocking `execSync` calls saturate the Node thread? |
| **Language (🇬🇧)** | **Zero Italian.** Scan ALL changed files: `.ts`, `.tsx`, `.css`, `.json`, `.md`, `.sh`. No Italian in: code comments, variable names, function names, UI strings, error messages, aria-labels, log messages, console output, commit messages, documentation. English only. If Italian is found, flag file:line + the Italian text. |

## Output format

The orchestrator produces a unified report **in Italian**, grouped by severity, with a section for discarded sub-agent hallucinations:

```
## 🔍 Deep Review — <branch>

### 🔴 CRITICAL
- file:linea — problem → fix

### 🟠 HIGH
- ...

### 🟡 MEDIUM
- ...

### 🟢 LOW
- ...

### ✅ Verified OK
- list of things checked and confirmed working

### ❌ Discarded (sub-agent hallucinations / false positives)
- claim → why it was discarded (proof: file doesn't exist, line doesn't match, intentional design, etc.)

## 📊 Summary
| Severity | Count |
|---|---|
| CRITICAL | n |
| HIGH | n |
| MEDIUM | n |
| LOW | n |
| Discarded | n |
```

No wall of text. Each issue: one line for the problem, one line for the fix.

## Rules

- **NEVER commit or push without the maintainer's explicit approval**
- Missing `maxDuration` in routes with long operations → flag as **HIGH**
- Italian text in code comments, strings, error messages, or logs → flag as **HIGH**
- Italian text in documentation → flag as **MEDIUM**
- Mount paths in code and docs must be identical — any divergence is **MEDIUM**
- Imported but unused functions → **LOW** (dead code)
- Files committed by mistake (review artifacts, backups, logs) → always flag
- Sub-agents use English internally. The final user-facing report is in Italian.

## Validation rules (orchestrator)

Before accepting any sub-agent finding, verify at least these:

1. **File exists?** — `ls -la <path>` or `read` the file.
2. **Line number correct?** — `read` with `offset` to the reported line, confirm the code matches the claim.
3. **Context correct?** — Is the finding about a line that was actually changed in the diff? If not, is it a pre-existing issue?
4. **Severity calibrated?** — Could this actually happen in production? Does it have a safety net (try/catch, fallback, validation)?
5. **Not fictional?** — Does the claim reference functions, variables, or files that don't exist? If yes → discard.
6. **Not a design choice?** — If the "issue" is an intentional trade-off (e.g., minimal setup, no rate limiting yet), note it but don't flag as a bug.
7. **Language (🇬🇧)?** — Any Italian word in source code, comments, error messages, UI strings, or docs? Flag it. Olympus repo rule: 100% English in everything except the final review report delivered to the maintainer.

If a sub-agent report is entirely low-quality (majority of claims are hallucinations), note this in the discarded section and consider re-spawning that sub-agent with a different model.
