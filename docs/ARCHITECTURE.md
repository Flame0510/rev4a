# Rev4a Architecture — Design & Vision

> **Status:** Active — `main` branch
> **Last updated:** 2026-06-30
> **Goal:** Transform Rev4a from a monitoring dashboard into a central orchestrator for a distributed multi-container agency.

---

## 1. Why Multi-Container?

### Current state (single container + dashboard)

```
┌─────────────────────────────────────────────┐
│  openclaw-core (1 container)                │
│                                             │
│  Rev4a (Next.js + daemon + SQLite)        │
│  OpenClaw runtime + systemd                  │
│  Subagents via sessions_spawn (same process)│
│  3+ agent workspaces (ops, prometheus, …)   │
│                                             │
│  ⚠️ 4 CPU, 15 GB RAM shared                 │
│  ⚠️ Single Node.js event loop               │
│  ⚠️ Everything competes for CPU/IO          │
└─────────────────────────────────────────────┘
```

**Pain points:**
- CPU-bound processes (ESLint, builds, daemon polling) compete
- Single event loop saturated by too many Node tasks
- Single SQLite WAL under concurrent load
- Impossible to use frameworks other than OpenClaw (Hermes, OpenCode)

### Target vision: Rev4a as orchestrator

```
┌────────────────────────────────────────────────────────────────┐
│  DOCKER HOST (203.0.113.10, 4 CPU, 15 GB RAM, 193 GB disk)   │
│                                                                │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────┐ │
│  │ rev4a-control  │  │ agent-argus      │  │ agent-atlas  │ │
│  │ (orchestrator)   │  │ (OpenClaw: Ops)  │  │ (OpenClaw:   │ │
│  │                  │  │                  │  │  Development)│ │
│  │ • Dashboard UI   │  │ • Session pool   │  │ • Session    │ │
│  │ • Config DB      │  │ • 2 CPU limit    │  │ • 2 CPU      │ │
│  │ • Docker socket  │  │ • 4 GB RAM limit │  │ • 4 GB RAM   │ │
│  │ • Auth gateway   │  │ • skills (ro)    │  │ • skills (ro)│ │
│  │ • Provider proxy │  │ • repos (rw)     │  │ • repos (rw) │ │
│  └────────┬─────────┘  └────────┬─────────┘  └──────┬───────┘ │
│           │                     │                    │         │
│  ┌────────┴─────────┐  ┌────────┴─────────┐  ┌──────┴───────┐ │
│  │ agent-prometheus │  │ agent-hermes     │  │ agent-future │ │
│  │ (OpenClaw: CRM)  │  │ (Hermes Agent)   │  │ (OpenCode?)  │ │
│  └──────────────────┘  └──────────────────┘  └──────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │ SHARED VOLUMES                                           │  │
│  │ • /docker/shared-skills → read-only on all agents        │  │
│  │ • /docker/shared-repos  → shared project repos           │  │
│  └──────────────────────────────────────────────────────────┘  │
│  └──────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────┘
```

---

## 2. Current Architecture (as of 2026-06-24)

### What's already been implemented

**Container separation:** `openclaw-atlas` already runs as a standalone container with `AGENT_ID=atlas`, discovered dynamically by Rev4a. This proves the container-per-agent model works.

**Vault system:** A credentials vault (`/vault` page) stores API keys and service tokens with per-agent permissions. File-backed vault system (removed - sensitive data is env-only).

**Container management UI:** The `/containers` page lists all running Docker containers with resource usage, logs, and quick links. Fully functional.

**Workspace API:** Lazy-loaded file tree explorer with real-time reads (no caching), supports both host and container workspaces via `docker exec`.

### What's in place but needs refinement

| Feature | Status | Notes |
|---|---|---|
| Vault (UI + API) | 🟢 Implemented | SQLite + JSON, no encryption yet |
| Container page | 🟢 Functional | Lists all containers, logs, resources |
| Agent creation wizard | 🟢 Implemented | One-click create with model/template selection |
| Provider proxy | 🟢 Implemented | Agents route through Rev4a provider gateway |
| Shared volumes | 🟢 Implemented | Skills + repos mounted on all agents |
| Central Oracle DB | 🔴 Not started | Events are per-container |
| Auto-registration | 🔴 Not started | New containers must be manually added |

---

## 3. Components (Target Architecture)

### 3.1 Rev4a Control Plane

The central container, running the Next.js dashboard + orchestration API.

**Responsibilities:**
- Web dashboard (Next.js, port 3740)
- REST orchestration API to spawn/stop/restart agents
- AI Provider Gateway (proxy for OpenAI, Anthropic, Groq, etc.)
- Centralized credential management
- Docker socket access for container management
- SQLite DB for cross-container event monitoring
- **Onboarding wizard** — first-run setup flow at `/onboarding`, tracks progress in `data/onboarding-progress.json`

**Volume mounts (target):**
```
/path/to/rev4a/data          → /data (persistent)
/var/run/docker.sock            → /var/run/docker.sock
/docker/shared-skills           → /data/.openclaw/shared-skills (ro)
/docker/shared-repos            → /data/repos (rw)
```

**Rev4a System Rules** (`rev4a-rules/AGENTS.md`):
- Versioned in the repo, deployed to `/docker/rev4a-rules/` on every `rev4a serve` start
- Mounted read-only into every agent at `/root/.openclaw/workspace/.rev4a/AGENTS.md`
- Injected into every session via the `bootstrap-extra-files` hook (glob `.rev4a/*.md`)
- Immutable by agents — enforced by the `:ro` mount
- See `lib/agent-setup.ts` for the centralized volume + config guarantee logic

### 3.2 Agent Container Template (`openclaw-agent-base`)

Docker image for every agent container.

**Contents:** See the live Dockerfile at
`agent-templates/base-image/Dockerfile` (authoritative source).
The image installs `openclaw`, `vercel`, `trello-cli`, `gh`, `supabase`,
copies the entrypoint script, and applies baseline gateway config patches.


**Volume mounts (per agent):**
```
/docker/shared-skills         → /data/.openclaw/shared-skills  (ro)
/docker/rev4a-rules         → /root/.openclaw/workspace/.rev4a (ro)
agent-{name}-data (named vol) → /root                            (rw, per-agent persistent state)
```

All shared volumes are defined centrally in `lib/agent-setup.ts`
(`REV4A_VOLUMES`) and used by both the create and recreate API routes.
The `bootstrap-extra-files` hook is pre-wired in the base image Dockerfile
and guaranteed at runtime by `applyRuntimeConfig()`.

**Injected environment variables:**
```
AGENT_NAME=<agent-name>
AGENT_TEMPLATE=<template>
OPENCLAW_GATEWAY_TOKEN=<shared agent token>
AGENT_HOSTNAME=<host-ip>:<portStart>
TZ=Europe/Rome
```

> **Note:** Provider API keys are never injected into agent containers. Agents use the Rev4a provider gateway at `http://host.docker.internal:3740/api/provider/v1` (resolved via `detectProviderGatewayUrl()`).

### 3.3 AI Provider Gateway (implemented)

The Provider Gateway is fully implemented and operational. Agent containers
point to the Rev4a provider proxy instead of using direct API keys.

**Flow:**

```
Agent Container          Rev4a Gateway              Provider API
     │                         │                         │
     │ Authorization: Bearer <gateway-token>             │
     │ POST /api/provider/v1/chat/completions            │
     │ model: rev4a/deepseek-v4-flash                  │
     │────────────────────────>│                         │
     │                         │ POST /v1/chat/completions│
     │                         │ Authorization: Bearer <real-key>
     │                         │────────────────────────>│
     │                         │       response          │
     │                         │<────────────────────────│
     │       response          │                         │
     │<────────────────────────│                         │
```

**Key characteristics:**

- The Rev4a server in `app/api/provider/v1/` acts as an OpenAI-compatible proxy
- Authentication uses `data/provider-keys.json` — the Bearer token must match
  the 'rev4a' entry
- Model lists (`GET /api/provider/v1/models`) return an empty list on invalid
  or missing token, preventing information leakage
- Chat requests (`POST /api/provider/v1/chat/completions`) return 401 on
  invalid or missing token
- API keys live only on the Rev4a server (in `data/provider-keys.json`),
  never inside agent containers
- The Gateway page (`/gateway`) provides a UI to manage provider keys and
  sync them to agent containers via `PUT /api/gateway/provider`

See [GATEWAY.md](dev/GATEWAY.md) and [PROVIDERS.md](dev/PROVIDERS.md) for
detailed documentation.

---

## 4. Credential Management (Vault)

Provider API keys are stored in `data/provider-keys.json`. Third-party service credentials
(GitHub, Trello, Vercel, Supabase) are stored in `data/credentials.db` (SQLite).
At agent spawn time, Rev4a injects only the credentials the agent is permitted to use.

```json
{
  "providers": {
    "openai-codex": "sk-...",
    "anthropic": "sk-ant-...",
    "groq": "gsk_..."
  },
  "services": {
    "github": { "token": "***", "user": "Flame0510" },
    "vercel": { "token": "***", "team": "flame0510" }
  },
  "agent_permissions": {
    "argus": ["providers:all", "services:github", "services:vercel"],
    "atlas": ["providers:openai-codex", "services:github"],
    "prometheus": ["providers:openai-codex"]
  }
}
```

**Current implementation:** SQLite (`credentials.db`) for services, JSON file (`provider-keys.json`) for provider keys (no encryption yet). Future: encrypted with AES-256-GCM or integrated with HashiCorp Vault / Vaultwarden.

---

## 5. Lifecycle Orchestration

### Agent spawn flow

```
Rev4a Dashboard UI
       │
       │ Click "New Agent"
       ▼
┌──────────────────────────────────────┐
│ 1. Template selection                │
│    - Choose template (argus/atlas/…) │
│    - Configure model, workspace, etc │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 2. Rev4a generates OpenClaw config │
│    - Takes template                  │
│    - Injects providers from vault    │
│    - Injects service tokens          │
│    - Writes to /docker/shared-config │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 3. Rev4a spawns Docker container   │
│    - docker run openclaw-agent-base     │
│    - Env vars + volumes              │
│    - network: rev4a-net            │
│    - CPU/RAM limits                  │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 4. Container self-configures         │
│    - Reads config from shared-config │
│    - Runs healthcheck                │
│    - Registers on Rev4a API        │
└──────────────┬───────────────────────┘
               │
               ▼
┌──────────────────────────────────────┐
│ 5. Agent ONLINE                      │
│    - Appears on dashboard            │
│    - Ready to receive tasks          │
└──────────────────────────────────────┘
```

### Implemented API endpoints

```
POST   /api/agents/create          Create new container agent (template + model)
DELETE /api/agents/{id}            Destructive: remove container + volume + backups
POST   /api/agents/{id}/restart    Restart container
POST   /api/agents/{id}/recreate   Rebuild from latest image (volume preserved)
GET    /api/agents                 List all agents (Docker containers with AGENT_ID)
```

---

## 6. Shared Volumes

### Shared Skills (`/docker/shared-skills`)
```
/docker/shared-skills/
  my-custom-skill/    # promoted from an agent workspace
    SKILL.md
  another-skill/
    SKILL.md
```

Skills are stored in a flat structure (no subcategory folders like `core/`, `ops/`, `dev/`).
This keeps the layout simple and avoids hierarchy debates at this stage.
**Permissions:**
- Rev4a host: rw (writes during promote, reads for listing)
- Agent containers: ro (mounted at `/data/.openclaw/shared-skills`)
- Owner: uid 1000 (node), group: 1000, mode: 2775 (setgid)

**Auto-configuration:**
- The agent base image (`openclaw-agent-base`) pre-configures `skills.load.extraDirs: ["/data/.openclaw/shared-skills"]` so every new agent discovers shared skills automatically.
- Both create and recreate routes guarantee this via `applyRuntimeConfig()` from `lib/agent-setup.ts`.
- On first install, create `/docker/shared-skills` with `mkdir -p /docker/shared-skills && chmod 2775 /docker/shared-skills`.

### Rev4a System Rules (`rev4a-rules/`)

Versioned in the repo at `rev4a-rules/AGENTS.md`. Deployed to
`/docker/rev4a-rules/` on every `rev4a serve` startup via
`ensureRev4aRules()` in `bin/rev4a.js`. Mounted read-only into every
agent container and injected into sessions through the
`bootstrap-extra-files` hook (glob `.rev4a/*.md`).

All shared volumes are defined in `lib/agent-setup.ts` — a single source
of truth used by both create and recreate API routes.

### Shared Repositories (`/docker/shared-repos`)
```
/docker/shared-repos/
  rev4a/     # the Rev4a repo
  projects/    # project repos for agents to work on
```
**Permissions:** rw for Rev4a and agents that need to write code.

---

## 7. Networking

All containers on the same Docker bridge network:

```yaml
networks:
  rev4a-net:
    driver: bridge
    ipam:
      config:
        - subnet: 172.28.0.0/16
```

**Communication:**
- Agent → Rev4a Gateway: `http://rev4a-control:3721`
- Agent → Rev4a Dashboard: `http://rev4a-control:3720`
- Rev4a → Agent (healthcheck): `http://agent-{id}:3000`
- Traefik → Agent (external access): via Docker labels

---

## 8. Daemon & Data Pipeline

The Rev4a daemon (`daemon.js`) is a standalone Node.js process that bridges the OpenClaw runtime and the SQLite database. It is not part of the Next.js server.

### Responsibilities

1. Poll `openclaw sessions --json --all-agents` on a configurable interval
2. Upsert session rows into `events.db`
3. Emit `spawn` / `complete` / `error` events into the `events` table
4. Collect system metrics (CPU, RAM, disk) every poll cycle
5. Detect anomalies (CPU > 90%, RAM > 90%) and log warnings
6. Manage DB lifecycle (WAL mode, checkpoint after each cycle)

### Poll Intervals

| Condition | Interval |
|---|---|
| No active sessions | 30 s |
| ≥ 1 session with status `working` | 15 s |

### Cost Estimation

Costs are estimated from token counts using per-model pricing:

| Model key | Match strategy | In (per 1M) | Out (per 1M) |
|---|---|---|---|
| `claude-sonnet-4` | substring | $3.00 | $15.00 |
| `claude-opus-4` | substring | $15.00 | $75.00 |
| `gpt-5-mini` | substring | $0.15 | $0.60 |
| `codex` | substring | $3.00 | $15.00 |
| `gemini` | substring | $0.075 | $0.30 |
| `flash` | substring | $0.075 | $0.30 |
| `deepseek` | substring | $0.55 | $2.19 |
| `default` | fallback | $3.00 | $15.00 |

**Aliases** (resolved before substring match):

| Alias | Resolves to |
|---|---|
| `cheap` | `flash` |
| `fast` | `claude-sonnet-4` |
| `big` | `claude-opus-4` |
| `coder` | `codex` |
| `pro` | `gemini` |
| `reason` | `deepseek` |

Formula: `cost = (tokens_in / 1_000_000 * price_in) + (tokens_out / 1_000_000 * price_out)`

### Upsert Logic

The daemon uses `INSERT … ON CONFLICT DO UPDATE` with these rules:

- `updated_at` is only refreshed when tokens or status actually change (avoids phantom updates)
- `parent_id` is updated only if the incoming value is better (non-null, and current is null or a generic `:main` default)
- `label` is updated only if the current value is null or still the raw session key (preserves declared names)
- `ended_at` is set once and never overwritten with null
- `trello_card_url` is set from `task_preview` on first occurrence; never overwritten

### System Metrics

Every poll cycle the daemon records a `system_metrics` row. Data sources:

- **CPU**: cgroup v2 usage delta (`/sys/fs/cgroup/cpu.stat`) when available, falls back to `/proc/stat` host ticks
- **RAM**: `/proc/meminfo`
- **Disk**: `df -BG /data`
- **Load**: `os.loadavg()[0]`

Metrics older than 24 h are pruned automatically each cycle.

### Anomaly Detection

The daemon compares the last two metric samples. If a threshold is exceeded and the cooldown (5 min) has passed, it logs a `WARN` line:

| Metric | Threshold |
|---|---|
| CPU | > 90% |
| RAM | > 90% |

### DB Safety

- WAL mode + `PRAGMA synchronous = NORMAL` for concurrent read safety
- `PRAGMA wal_checkpoint(PASSIVE)` runs after each poll cycle
- On `uncaughtException` the daemon logs but does NOT exit — relies on systemd Restart=always for recovery

### Migrations

The daemon applies these migrations at startup if columns don't exist:

```sql
ALTER TABLE sessions ADD COLUMN trello_card_url TEXT;
ALTER TABLE sessions ADD COLUMN ended_at INTEGER;
```

---

## 9. Migration Plan

### Phase 0 — Preparation (✅ Done)
- [x] Architecture document exists
- [x] Rev4a code is in the workspace
- [x] Git repository on `github.com/Flame0510/rev4a.git`
- [x] VPS-specific changes merged into `main` branch

### Phase 1 — Container separation
- [x] `openclaw-atlas` running as standalone container
- [ ] Create `openclaw-agent-base` Docker image and push to registry
- [ ] Define shared volume structure
- [ ] Test cross-container communication

### Phase 2 — Provider Gateway
- [x] Implement proxy API on Rev4a (`/api/provider/v1/`)
- [x] Gateway Page (`/gateway`) for provider key management
- [x] Agent model configuration via Gateway Agents tab
- [x] Provider sync to agent containers (`PUT /api/gateway/provider`)
- [x] Auth via rev4a token in `data/provider-keys.json`
- [ ] Rate limiting per agent
- [ ] Transparent provider switching (change keys in one place)

### Phase 3 — Full agent extraction
- [ ] Move Prometheus to its own container
- [ ] Move Argus to its own container
- [ ] Rev4a becomes pure orchestrator (no agent sessions)

### Phase 4 — Alternative runtimes
- [ ] Test Hermes in a dedicated container
- [ ] Test OpenCode in a dedicated container
- [ ] Unified dashboard for all runtime types

### Phase 5 — Automation
- [ ] `rev4a agents spawn` CLI command
- [ ] Auto-scaling? (spawn more agents under load)
- [ ] Automated vault + config backups

---

## 10. Open Questions

1. **Provider Gateway: custom proxy or existing product?**
   - Option A: Homemade proxy (Node.js, lightweight, integrated in Rev4a)
   - Option B: LiteLLM / Portkey (more features, heavier)
   - Recommendation: start with homemade (A) — Rev4a is already Node.js

2. **Memory: centralized or distributed?**
   - Centralized: simpler, single DB, single point of contention
   - Distributed: per-agent memory, Rev4a indexes centrally — more resilient
   - Recommendation: distributed with central index

3. **Traefik routing: should agents be externally reachable?**
   - If yes: per-agent Traefik labels managed by Rev4a
   - If no: internal Docker network only
   - Recommendation: no by default, yes only for agents serving APIs/UI

4. **Hermes and other frameworks: dashboard integration?**
   - Hermes has its own session format
   - Rev4a daemon should have "adapters" for different runtimes
   - Or Hermes exposes an API compatible with OpenClaw format

5. **Resource calc: enough for 3-4 agent containers?**
   - Estimate: 1 Rev4a (~500 MB) + 3 agents (~2 GB each) = 6.5 GB RAM
   - CPU: with limits, 3-4 agents should run fine
   - Monitor: if saturated, consider VPS upgrade

---

## 11. Container Terminal

Rev4a provides a real, interactive terminal for any agent container via
a WebSocket-connected PTY. The implementation is documented in detail in
[docs/container-terminal.md](container-terminal.md).

### Two-process architecture

| Process | Port | Role |
|---|---|---|
| `rev4a-next` (Next.js) | 3740 | Serves the terminal page, auth, API |
| `rev4a-terminal-ws` (standalone) | 3741 | WebSocket PTY server via `node-pty` |

The terminal server runs as a separate systemd service (rev4a-terminal-ws) to avoid event-loop
contention with Next.js during high-throughput I/O.

### Why custom DOM over xterm.js

The initial implementation used xterm.js (both canvas and DOM renderers).
Both suffered from black-screen-on-large-output and broken scrolling due to
CSS conflicts. The current implementation uses a plain `<div>` with native
browser scrolling and a hidden `<textarea>` for input — stable under any
output volume.

See [container-terminal.md](container-terminal.md#terminal-client-browser)
for the full rationale.

## 12. Technology Stack

| Layer | Technology | Notes |
|---|---|---|
| Orchestrator | Docker / Docker Compose | Already in use |
| Dashboard | Next.js 16 + React 19 | Current Rev4a |
| Provider Gateway | Express/Fastify (Node.js) | To implement in Rev4a |
| Database | SQLite (WAL mode) | Current `events.db`, may need to scale |
| Memory | Per-agent SQLite + central index | New |
| Config | Generated YAML/JSON | New |
| Vault | SQLite + JSON | Current: credentials.db + provider-keys.json. Future: encrypted |
| Reverse proxy | Traefik | Already in use |
| Monitoring | Rev4a daemon (extended) | Evolution of current daemon |
| Version control | Git + GitHub | `github.com/Flame0510/rev4a.git` |
