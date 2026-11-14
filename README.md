# REV4A — Multi-Agent Dashboard for OpenClaw

> **One command to deploy a management dashboard for your OpenClaw agent fleet.**
> Zero external databases. Only Node.js + Docker.

**Live demo:** —

---

## ✨ Features

- **Multi-container agent management** — Create, monitor, and manage OpenClaw agents in isolated Docker containers from a single UI
- **Agent creation wizard** — Pick a template (Atlas, Prometheus, Argus), choose an LLM model, deploy an agent in seconds
- **Provider sync** — Add API keys once, push them to all agent containers with one click
- **Model configuration** — Change the primary model and fallbacks per agent, from the detail panel on the Agents page. Providers: OpenAI, Anthropic, Google, DeepSeek, Groq, Kimi, GLM, Qwen, plus OpenRouter as an aggregator.
- **Model details** — Every model row opens a modal with its description, price and provider, architecture and parameter count (mixture of experts, context, vision encoder, precision, weights on disk), reasoning modes, capabilities, benchmarks with sources and licence. Numbers come from the model card on Hugging Face plus curated entries that cite a source; nothing is estimated
- **Shared gateway token** — One token to rule all agents. Manage from the dashboard, sync to all containers
- **Live event stream** — Real-time session lineage, agent spawning, cost reporting
- **Workspace browser** — Browse, preview and edit agent files live from the dashboard (Markdown, highlighted code, JSON, CSV tables, PDF, images, audio and video)
- **Provider proxy** — OpenAI-compatible chat completions proxy that routes through a shared key vault
- **System health** — runtime sessions, daemon heartbeat and failed runs, cron jobs and what the agents spent today, with recommendations
- **System** — the host machine's CPU, memory, swap and storage, now and over 1h / 24h / 7d / 30d (sampled every 30 s, kept 30 days); what each agent and container consumes (CPU, memory, storage, processes — charts per container) and what Docker holds on disk; recent alerts for the machine and its containers, plus spend and loop alarms (a session past its model's context window, a day of spend far above the agent's usual day, a failing retry loop, money leaving a provider account that Rev4a did not meter; alarms only, snoozable)
- **Memory limit per agent** — optional, never imposed: set it for an agent in its RESOURCES section (applied live), when creating one, or as a default that only prefills new agents on the Configuration page. Usage is shown against it, an out-of-memory kill appears under Recent alerts, and the System page warns when memory is high and running agents have no limit
- **Subscriptions** — connect a ChatGPT Plus or Pro (Codex) account to an agent with a device code, or a Claude Pro/Max plan through a guided sign-in (Experimental: Rev4a installs Claude Code, opens Anthropic's page and takes the code you paste), then pick the subscription model next to the Rev4a proxy models in the agent's MODEL section, with the previous model pre-filled as the fallback; the sign-in stays inside the agent
- **Costs** — what each agent spent, priced by its own OpenClaw with the prices Rev4a syncs (cache rates included, DeepSeek off-peak applied): by day, agent, model and session, with the calls that could not be priced
- **Per-agent metering at the proxy** — every call through the Rev4a provider proxy is counted per agent with the provider's own token counts and the price in force at that moment; the Costs page sets it next to what each agent recorded and marks an agent the proxy saw clearly more of
- **Update screen** — while Rev4a updates itself, every open tab shows the phase and the log, and the server refuses changes (reads and the agents' proxy keep working) until the new version answers
- **PWA-ready** — Install on phone for mobile monitoring

---

## Quick Start

On an Ubuntu VPS, install Node.js 22 and the build tools first. Rev4a does not install
Node.js. These commands run Rev4a as root, with its data in `/root/.config/rev4a`.
Use `sudo` from a sudo-enabled account or as root.

```bash
# Node.js 22, build tools and the current npm package (it provides the rev4a command).
# Each step runs only if the previous one succeeded.
sudo apt-get update \
  && sudo apt-get install -y curl build-essential \
  && curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh \
  && sudo bash /tmp/nodesource_setup.sh \
  && sudo apt-get install -y nodejs \
  && sudo npm i -g @flame0510/project-aether

# Then, once the install above finished without errors, start everything:
sudo rev4a serve
```

The npm install compiles native modules and builds the dashboard. On first start,
`rev4a serve` creates `/root/.config/rev4a/.env`, installs Docker if missing on Linux
when run as root, creates `rev4a-network`, pulls the agent image, and starts all services.
Wait for the dashboard to listen on port 3740 and the `[SETUP]` code to appear.

**Plain HTTP or HTTPS:** HTTPS through a reverse proxy is recommended. If you use plain
HTTP by IP, stop the foreground server with **Ctrl+C**, set
`REV4A_FORCE_INSECURE_COOKIE=1` in `~/.config/rev4a/.env` (root's file in this guide),
and restart before opening the dashboard; otherwise login loops after the wizard:

```bash
printf '\nREV4A_FORCE_INSECURE_COOKIE=1\n' | sudo tee -a /root/.config/rev4a/.env
sudo rev4a serve
```

Open `http://<server>:3740` (replace `<server>` with your VPS IP), or your HTTPS
dashboard address. Enter the **Setup code** printed by the current `rev4a serve`,
choose your dashboard password, and complete the wizard. The code changes on each
start until a password exists; configured installs do not print or require it.

Then [run it as a service](./CONNECT.md#run-it-as-a-service-systemd) so it starts on
boot. [CONNECT.md](./CONNECT.md#deploy-on-a-vps) has the full VPS guide, including
the systemd unit and logs.

```bash
# Custom port:
sudo rev4a serve --port 8080

# Or via the environment:
sudo env PORT=8080 rev4a serve
```

> **Production install:** see `CONNECT.md` for systemd deployment on a VPS.
>
> **Container deploy:** on hold. The root `Dockerfile` (Docker-in-Docker packaging of
> the dashboard itself) is an experimental path, not currently built or published —
> see the file for details. Use the git-clone install above.

---

## Prerequisites

| Dependency | Minimum | Notes |
|---|---|---|
| Node.js | 22 | Required for the dashboard server |
| Build tools | `make`, `g++`, `python3` | Native modules (`better-sqlite3`, `node-pty`) compile on Linux. Install `build-essential` on Debian/Ubuntu; Ubuntu 24.04 already includes `python3` |
| Docker | 24+ | Required for creating agent containers; installed by `rev4a serve` if missing when run as root on Linux |
| npm | 10+ | Comes with Node.js |

**That's it.** No PostgreSQL, no Redis, no external services.

---

## Development

Contributors can work from a git clone after installing the prerequisites above:

```bash
git clone https://github.com/Flame0510/rev4a.git
cd rev4a
npm install
npm run dev
```

The development server uses port 3720. Direct Next.js starts (`npm run dev`) print
the setup code in that terminal on the first setup request.

---

## Environment Variables

`rev4a serve` generates `~/.config/rev4a/.env` on first run with the secrets
already filled in — you normally never set these by hand. See
[.env.example](./.env.example) for the full reference.

| Variable | Default | Required | Description |
|---|---|---|---|
| `PORT` | `3740` | No | Dashboard HTTP port |
| `TERMINAL_WS_PORT` | `3741` | No | Loopback port of the container terminal server (the browser uses the dashboard's port) |
| `REV4A_PASSWORD` | — | Yes | Dashboard login password (set via the setup wizard) |
| `REV4A_FORCE_INSECURE_COOKIE` | — | No | Set to `1` for plain HTTP by IP to avoid login loops; restart after changing it. Prefer HTTPS through a reverse proxy |
| `REV4A_TOKEN` | auto-generated | Yes | Bearer token for API routes and agent calls |
| `REV4A_JWT_SECRET` | auto-generated | Yes | Secret for auth cookies |
| `REV4A_API_KEY` | auto-generated | No | API key for the Gateway provider endpoint |
| `GATEWAY_TOKEN` | auto-generated | No | Shared token handed to agent containers |
| `REV4A_DATA_DIR` | `~/.config/rev4a` | No | Root of all persistent data |
| `REV4A_DB` | `<data dir>/data/events.db` | No | SQLite database path |
| `REV4A_DEV_ORIGINS` | — | No | Extra comma-separated hostnames or IPs allowed to reach `next dev` (e.g. a LAN address, without scheme or port); no effect on a production build |
| `REV4A_ALLOWED_ORIGINS` | — | No | Extra trusted browser origins for cookie-authenticated API writes when a reverse proxy rewrites `Host`. Comma-separated full origins, e.g. `https://rev4a.example.com`; no wildcards. Restart Rev4a after changing it |
| `REV4A_SKIP_POSTINSTALL_BUILD` | — | No | `1` in CI so `npm ci` skips the post-install `next build`; the workflows build as a separate step. Outside CI, a failed post-install build fails the installation. Any non-empty value skips it, `0` included |
| `REV4A_AGENT_IMAGE_REGISTRY` | `ghcr.io/flame0510/rev4a/openclaw-agent-base` | No | Registry repository agent images are pulled from, as `<repository>:<OpenClaw version>`. A `localhost` registry is reached over plain HTTP |
| `REV4A_TRUSTED_PROXIES` | — | No | Comma-separated IPs or CIDRs (e.g. `192.0.2.10`; `127.0.0.1,::1` for a proxy on the same host) of the reverse proxies whose `X-Forwarded-For` names the client for the login lock. Unset: no `X-Forwarded-For` is trusted. List the proxy's own address, pinned and not on `rev4a-network` with the agents |
| `REV4A_TIMEZONE` | server's own zone | No | Default dashboard time zone (IANA name, e.g. `Europe/Rome`), used only while none is saved in *Config > Time zone*; an invalid name is ignored |
| `REV4A_DOCKER_WAIT_SECONDS` | `90` | No | How long `rev4a serve` waits for the Docker daemon at start-up before starting without it. Capped at 600; `0` checks once; a negative or non-numeric value means 90. Read from the process environment, not from the `.env` file |

**Login lock:** from the 6th wrong password within an hour the dashboard locks that client address (30 s, doubling up to 15 minutes). Behind a reverse proxy, the proxy must send the real client in `X-Forwarded-For` and its address must be set in `REV4A_TRUSTED_PROXIES` (`127.0.0.1` for a proxy on the same host); without it every visitor shares one login-throttle key.

**SEC-21 update note:** after updating, every browser has to log in once. Browser
session cookies now carry a keyed password fingerprint; cookies from earlier releases
are refused. Once a password change takes effect, all cookies issued for the previous
password are refused by API authentication, protected pages and terminal WebSocket
upgrades. A password saved in Config takes effect after restarting Rev4a. The 7-day
cookie lifetime, cookie flags and `REV4A_TOKEN` Bearer access are unchanged. No stored
data, configuration files or agent volumes are migrated or deleted.

**SEC-22 update note:** Gateway key saves reject ASCII control characters before
trimming. Old malformed upstream keys fail closed; replace them in Gateway.
Proxy exceptions return `Gateway error: the upstream request failed` (502) and
log only the error name/code, keeping credentials out of fetch error messages.
Commands fed through stdin now reject output beyond their combined stdout/stderr
limit (1 MiB by default), rather than collecting it without a bound. Container
recreates retain specific IPv4/IPv6 publish addresses and UDP; ordinary wildcard
publishes still produce one mapping. Config, initial password setup and shared environment writes enforce
`.env` mode `0600`; startup also repairs older files with broader permissions and
logs the repair once. The unused `remove-auth-profile.js` maintenance helper was
removed. No database, provider vault or agent volume migration is required;
older agents and rollback remain compatible. An address restriction already lost
in an earlier recreate cannot be inferred from the resulting Docker inspect.

**SEC-18 update note:** cookie-authenticated API writes now reject foreign origins with
`403 { "error": "Cross-site request refused" }`, including sibling subdomains and other ports.
A request the browser marks `Sec-Fetch-Site: same-origin` is accepted (every current browser
sends it, and it stays right behind a reverse proxy, nginx included). Otherwise the browser's
`Origin` host and port must match `Host` (case-insensitive).
Explicit and implicit default ports match (HTTP :80, HTTPS :443), using the Origin's scheme.
Only for an old browser without fetch metadata behind a proxy that rewrites `Host`, set `REV4A_ALLOWED_ORIGINS` to the dashboard's public
origin and restart Rev4a; only list origins you control. With no `Origin`, requests marked
`Sec-Fetch-Site: cross-site` or `same-site` are refused; `same-origin`, `none` and absent
metadata still work. `Origin: null` is refused. Requests with an `Authorization` header
and GET/HEAD/OPTIONS keep their existing behaviour; agents using Bearer keys keep working.
The unused gateway provider OAuth device-flow endpoint has been removed. The active
per-agent ChatGPT connection on the Subscriptions page is unchanged. No stored data or
credentials are migrated or deleted.

**SEC-14 update note:** first-run setup now requires the operator's setup code.
Environment edits require string values without CR, LF or NUL (clearing a stored
non-empty Config value removes its assignment; unchanged empty assignments stay).
Loader settings are no longer read from `.env`: at start
`rev4a serve` comments out `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`, `LD_PRELOAD`,
`LD_LIBRARY_PATH` and `DYLD_*` lines in `.env` (Next.js reads `.env` itself for the build
and the server, so ignoring them in the launcher alone is not enough) and logs the key
names, never the values. Set such options in the shell or systemd environment instead. After the line repair, the launcher asks Next.js's own `.env` loader (`@next/env`, in a separate process) which keys it would load from the package root: if a loader key is still there in a form the line repair cannot follow (for example the key and its `=` on different lines), Rev4a refuses to start and logs the key name with the file to fix (if that check itself cannot run, it logs a warning and starts, relying on the line repair and on `server.js` removing loader keys Next loaded). Values are written so that Next.js and Rev4a read them back exactly: a value with `#`, leading or trailing spaces or a leading quote is single-quoted; a value containing `$` is refused with 400 (Next.js expands `$VAR` in every `.env` value it loads, even single-quoted, and its server overwrites what the launcher passed, so a password with `$` would change after a restart; values already in `.env` are not touched), and so is one that cannot be represented (a single quote combined with leading/trailing spaces, `#` or a leading quote; a backslash at the end of a quoted value; a Unicode line separator).
Loader settings inherited from the operator's shell or systemd environment are preserved,
including `NODE_OPTIONS=--max-old-space-size=4096`. Other operator-defined keys still
reach child processes. The setup code is runtime-only: Config never returns or
persists `REV4A_SETUP_CODE`, and the launcher ignores it in `.env`. Environment
writes abort on read errors other than a missing file; existing dotted keys remain
valid when saving other keys. Existing passwords and stored data are unchanged.

**BUG-14 update note:** Config saves only edited values and patches `.env` in place,
preserving other keys (including `GATEWAY_TOKEN` and `PORT`), comments, blank lines
and order. Values shown from the process environment are not saved unless edited.
Unchanged values (also empty ones) stay byte-for-byte intact, and an unchanged
GET-to-PUT round trip does not write the file. Rev4a edits `.env` automatically only when every line is blank, a comment or a one-line `KEY=value` (a quoted value closing on the same line). A file with a multi-line or unterminated quoted value, a value on the next line, text after a closing quote (including an inline comment such as `REV4A_TOKEN="t" # comment`), or a backslash immediately before a same-kind quote (including the closing quote) is ambiguous across tools: an edit from Config then answers `409` and writes nothing (edit the file by hand), and the startup repair of runtime keys is skipped with a log line. Unchanged values, including inherited multi-line ones, are never an edit.
`REV4A_SERVER_PID`, `REV4A_STARTED_AT`, `REV4A_RUNNING_VERSION`,
`REV4A_TERMINAL_SECRET` and `REV4A_SETUP_CODE` are never returned by Config and are
silently ignored on save, including from older open tabs. At startup, `rev4a serve`
automatically removes existing assignments of those five runtime-only keys from
`.env`, logging names only; a second pass makes no further changes. Inherited
copies of these keys (including from systemd's `EnvironmentFile`) are
also cleared from the base child environment before fresh per-boot values are set.
Previously deleted keys and comments cannot be restored automatically. No database, provider
key file or agent volume changes are required; older agents and rollback remain
compatible with the resulting `.env`.

**FIX-133 update note:** Config edits now replace the last assignment of an edited key
and remove earlier duplicates; clearing a stored non-empty value removes all its assignments.
Config and runtime-key cleanup operate on physical lines only after the plain-file check
above, preserving unrelated settings. Ambiguous quotes are refused with visible recovery
instructions beside **Save & Restart**. Previously deleted settings cannot be reconstructed.
The automatic, logged loader repair also recognizes lone CR separators, `KEY: value` and
`export KEY=` forms, retaining original line endings; it comments matching lines even inside
quoted multiline values, while runtime cleanup skips non-plain files. Run it again and
it makes no further changes. A partial skill promotion now reports skipped files. Control UI
links from `::1` / `[::1]` use `localhost` so IPv6-only publishes remain reachable while
using a separate cookie host; older agents retain the token-link fallback. CLI image
commands and git updates pass literal arguments and checkout paths without a shell.
No database, provider key file or agent volume migration is required, no new startup
scan of stored data is added, and older releases can still read the resulting files on rollback.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                   REV4A Dashboard              │
│  Next.js 16 · SQLite · no external dependencies  │
└──┬───────┬───────┬───────┬───────┬───────────────┘
   │       │       │       │       │
   ▼       ▼       ▼       ▼       ▼
 Agent  Agent   Agent   Gateway  Provider
  #1     #2      #3      Vault    Proxy
┌──────┐┌──────┐┌──────┐┌──────┐┌────────────┐
│Docker││Docker││Docker││Shared││OpenAI-comp.│
│Open- ││Open- ││Open- ││Token ││chat proxy  │
│Claw  ││Claw  ││Claw  ││Store ││with key    │
│Agent ││Agent ││Agent ││      ││vault       │
└──────┘└──────┘└──────┘└──────┘└────────────┘
```

**Key design decisions:**
- Every agent runs in an **isolated Docker container** with its own OpenClaw instance
- Container state is ephemeral; persistent data lives in shared volumes
- Provider API keys are stored once in `data/provider-keys.json` and synced on demand
- No PostgreSQL, no Redis — the entire dashboard uses SQLite via `better-sqlite3`
- Gateway token is shared across all containers and managed from the UI

---

## Documentation

| Document | What it covers |
|---|---|
| [AGENTS.md](./AGENTS.md) | Repository entry point and contribution rules |
| [docs/REV4A.md](./docs/REV4A.md) | App pages, navigation, agent management, gateway UI |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | System architecture and component layout |
| [docs/FRONTEND-ARCHITECTURE.md](./docs/FRONTEND-ARCHITECTURE.md) | Frontend structure and design decisions |
| [docs/CONTAINER-TERMINAL.md](./docs/CONTAINER-TERMINAL.md) | Terminal WebSocket implementation |
| [docs/DESIGN-SYSTEM.md](./docs/DESIGN-SYSTEM.md) | Design tokens and visual standards |
| [docs/dev/API-REFERENCE.md](./docs/dev/API-REFERENCE.md) | All API endpoints with request/response examples |
| [docs/dev/GATEWAY.md](./docs/dev/GATEWAY.md) | Provider sync and agent model configuration |
| [docs/dev/PROVIDERS.md](./docs/dev/PROVIDERS.md) | Provider login, key management, proxy details |
| [docs/dev/DATABASE.md](./docs/dev/DATABASE.md) | SQLite schema and storage notes |
| [docs/dev/WORKSPACE.md](./docs/dev/WORKSPACE.md) | Workspace file explorer and editor |
| [SECURITY.md](./SECURITY.md) | How to report a vulnerability privately, supported versions |

---

## Agent Templates

| Template | Role | Description |
|---|---|---|
| **Atlas** | Developer Lead | Coding, software architecture, PR reviews, code review |
| **Prometheus** | Tech Lead / PM | Client projects, deadlines, Trello, deliverables |
| **Argus** | Ops Lead | Infrastructure monitoring, backups, cron, alerting |

Templates are plain Markdown files (SOUL.md, AGENTS.md, IDENTITY.md, etc.) that
define the agent's personality and rules. They mount into `/root/.openclaw/workspace/`
at container creation time.

---

## Comparison

| | REV4A | Clawix | NanoClaw | MetaClaw |
|---|---|---|---|---|
| **Dashboard** | ✅ Full web UI | ✅ Full web UI | ❌ Chat only | ❌ Chat only |
| **Container isolation** | ✅ Docker per-agent | ✅ Docker per-agent | ✅ Docker per-agent | ✅ Docker per-agent |
| **Agent runtime** | OpenClaw | Proprietary | Claude Code | Claude Code |
| **Database** | SQLite (zero setup) | PostgreSQL + Redis | SQLite | SQLite |
| **External services** | None | PostgreSQL + Redis | None | None |
| **Install** | npm global package | docker compose | bash script | npm install |

---

## License

MIT — see [LICENSE](./LICENSE).
