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
- **Workspace browser** — Browse and edit agent files live from the dashboard
- **Provider proxy** — OpenAI-compatible chat completions proxy that routes through a shared key vault
- **System health** — runtime sessions, daemon heartbeat and errors, cron jobs and what the agents spent today, with recommendations
- **System** — the host machine's CPU, memory, swap and storage, now and over 1h / 24h / 7d / 30d (sampled every 30 s, kept 30 days)
- **Costs** — what each agent spent, priced by its own OpenClaw with the prices Rev4a syncs (cache rates included, DeepSeek off-peak applied): by day, agent, model and session, with the calls that could not be priced
- **PWA-ready** — Install on phone for mobile monitoring

---

## Quick Start

```bash
# Requirements: Node.js 22+ and Docker
git clone https://github.com/Flame0510/rev4a.git
cd 'rev4a'
npm install

# One command to start everything:
rev4a serve
```

Rev4a auto-builds on first run, generates `.env` with credentials,
and starts all services. Open `http://localhost:3740` and follow the setup wizard.

```bash
# Custom port:
rev4a serve --port 8080
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
| Docker | 24+ | Required for creating agent containers |
| npm | 10+ | Comes with Node.js |

**That's it.** No PostgreSQL, no Redis, no external services.

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
| `REV4A_TOKEN` | auto-generated | Yes | Bearer token for API routes and agent calls |
| `REV4A_JWT_SECRET` | auto-generated | Yes | Secret for auth cookies |
| `REV4A_API_KEY` | auto-generated | No | API key for the Gateway provider endpoint |
| `GATEWAY_TOKEN` | auto-generated | No | Shared token handed to agent containers |
| `REV4A_DATA_DIR` | `~/.config/rev4a` | No | Root of all persistent data |
| `REV4A_DB` | `<data dir>/data/events.db` | No | SQLite database path |
| `REV4A_WORKSPACE_ROOT` | — | No | Root exposed by the local file explorer |
| `REV4A_DEV_ORIGINS` | — | No | Extra comma-separated hostnames or IPs allowed to reach `next dev` (e.g. a LAN address, without scheme or port); no effect on a production build |
| `REV4A_SKIP_POSTINSTALL_BUILD` | — | No | `1` in CI so `npm ci` skips the post-install `next build`; the workflows build as a separate step. Any non-empty value skips it, `0` included |
| `REV4A_AGENT_IMAGE_REGISTRY` | `ghcr.io/flame0510/rev4a/openclaw-agent-base` | No | Registry repository agent images are pulled from, as `<repository>:<OpenClaw version>`. A `localhost` registry is reached over plain HTTP |
| `REV4A_DOCKER_WAIT_SECONDS` | `90` | No | How long `rev4a serve` waits for the Docker daemon at start-up before starting without it. Capped at 600; `0` checks once; a negative or non-numeric value means 90. Read from the process environment, not from the `.env` file |

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
| **Install** | git clone + npm | docker compose | bash script | npm install |

---

## License

MIT — see [LICENSE](./LICENSE).
