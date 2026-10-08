# Rev4a — VPS Dashboard

> **Last updated:** 2026-10-06

A Next.js 16 dashboard for monitoring and managing the OpenClaw ecosystem.

**URL:** `http://<vps-ip>:3740` (or behind a reverse proxy of your choice)
**Port:** 3740
**Process manager:** `rev4a serve` (single command). Production: systemd service (`rev4a.service`).
**Repository:** `github.com/Flame0510/rev4a.git` (branch: `main`)

---

## Architecture

```
              Browser (directly, or through a reverse proxy of your choice)
                         │
              ┌──────────┴──────────────────┐
              │  rev4a serve                │
              │  (systemd: rev4a.service)   │
              │  server.js       :3740      │
              │  (Next.js 16 + terminal WS) │
              │  daemon.js                  │
              │  terminal-ws  :3741 (local) │
              └──────────┬──────────────────┘
                         │
                docker exec / Docker API
                         │
           ┌─────────────┴─────────────┐
    ┌──────┴──────┐             ┌──────┴──────┐
    │ agent       │     …       │ agent       │
    │ container   │             │ container   │
    │ (OpenClaw)  │             │ (OpenClaw)  │
    └─────────────┘             └─────────────┘
```

### Environment

Rev4a reads the following environment variables. Set them in `/config` (UI) or directly in `.env`, except the three read before `.env` is loaded — `REV4A_DATA_DIR`, `REV4A_DOCKER_WAIT_SECONDS` (both from the process environment: a shell export or a systemd `Environment=` line) and `REV4A_SKIP_POSTINSTALL_BUILD` (read by `npm install`). See [.env.example](../.env.example) for the canonical, always-current list.

| Variable | Required | Description |
|---|---|---|
| `REV4A_PASSWORD` | Yes | Login password for the dashboard |
| `REV4A_TOKEN` | Yes | Token used for programmatic API access |
| `REV4A_JWT_SECRET` | Yes | Secret used to sign session JWT tokens |
| `REV4A_API_KEY` | No | API key for the Gateway provider endpoint (auto-generated) |
| `GATEWAY_TOKEN` | No | Shared token handed to agent containers |
| `REV4A_DATA_DIR` | No | Root of all persistent data (default: `~/.config/rev4a`) |
| `REV4A_DB` | No | Path to the events database (default: `<data dir>/data/events.db`) |
| `REV4A_CREDENTIALS_DB` | No | Path to the credentials vault database |
| `REV4A_WORKSPACE_ROOT` | No | Filesystem path for the local file explorer |
| `REV4A_ROOT` | No | Installation root, used by `rev4a update` to detect a git checkout |
| `REV4A_TIMEZONE` | No | IANA timezone used for scheduling and timestamps |
| `REV4A_FORCE_INSECURE_COOKIE` | No | `1` allows a non-Secure session cookie — plain-HTTP deployments only (any other value, `true` included, does nothing) |
| `REV4A_AGENT_IMAGE_REGISTRY` | No | Registry repository agent images are pulled from (default: `ghcr.io/flame0510/rev4a/openclaw-agent-base`); a `localhost` registry is reached over plain HTTP |
| `REV4A_DOCKER_WAIT_SECONDS` | No | How long `rev4a serve` waits for the Docker daemon at start-up (default `90`, capped at 600) |
| `REV4A_DEV_ORIGINS` | No | Extra comma-separated hostnames or IPs allowed to reach `next dev`; no effect on a production build |
| `REV4A_SKIP_POSTINSTALL_BUILD` | No | `1` in CI: `npm ci` then skips the post-install `next build` (the workflows build as a separate step). An installation build failure exits non-zero; startup checks `.next/BUILD_ID` before serving. Any non-empty value skips the post-install build, `0` included — leave it unset to build |

See [Alerts](#alerts-telegram) below for the Telegram alert variables.

## Agent creation

Every agent is created with:

- A host port mapping (`-p <port>:3000`) for direct access
- Control UI at `http://<host>:<port>`, opened from the Agents page through `GET /api/agents/[id]/open-control-ui`
- The provider gateway at `http://host.docker.internal:3740/api/provider/v1`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true`, so the Control UI opens on whatever host the agent is reached on, and pages from other origins are refused
- `--init`: Docker's tini runs as PID 1, with OpenClaw as its child, and collects orphaned processes the moment they exit. Without it `openclaw-gateway` is PID 1 and never collects them: every process a tool leaves behind (Chrome, builds, scripts) stays a zombie and counts against the container's pids limit (9 365 on the VPS) until the container cannot start anything. Measured before the fix: 1 542 zombies in one agent after four days of browsing and builds. tini forwards `docker stop`'s SIGTERM, so OpenClaw still shuts down cleanly. Set at create and in `recreateAgentContainer` (recreate, update, edit); an existing agent gets it the next time it is recreated.

The port is auto-assigned starting from 3000 (or user-specified).

Domain and HTTPS routing (Traefik) is an external concern — operators can
configure it on top of the base setup if needed, but Rev4a does not couple
to any specific reverse proxy.

## Config persistence

When environment variables are saved via the Config page (Save & Restart):

1. Values are merged into the data directory's `.env` (`~/.config/rev4a/.env`; the
   `.env` in the installation root is a link to it). An empty value removes the key.
2. `sudo systemctl daemon-reload` is attempted; it is harmless where there is no systemd.
3. **Save & Restart** runs `sudo systemctl restart rev4a.service`: the restart only works
   when Rev4a runs as that systemd service. Started any other way, restart `rev4a serve`
   yourself — `serve` reads `.env` at start-up, so nothing changes until then.

## Components

- **Rev4a:** Next.js app serving the dashboard UI and REST API. Reads Docker state, container configs, and agent workspaces via `docker exec` and `fs` calls.
- **Traefik:** External reverse proxy (optional). Rev4a does not depend on it — operators can use any reverse proxy or none at all.
- **OpenClaw agents:** Docker containers with `AGENT_ID` label. Rev4a discovers them dynamically via `docker ps`.

---

## Pages

| Route | Description |
|---|---|
| `/` | System overview — health, sessions, the machine's CPU / RAM / disk (links to `/system`), what the agents spent today (as on `/costs`), live feed |
| `/agents` | Running agents (Docker containers with `AGENT_ID`), gateway token management, agent creation wizard, channel manager (Telegram pairing) |
| `/containers` | All Docker containers on the host, each running one with its CPU, memory and processes now (from the daemon's container samples) and a link to its charts |
| `/costs` | What each agent spent, as its own OpenClaw priced it with the rates Rev4a syncs: today / 7 / 30 UTC days, by day, by agent, by model, the most expensive sessions, the calls that could not be priced, the DeepSeek band now, **metered at the proxy** next to **recorded by the agent**, per agent (the proxy counts every call it carries, the agent only what it recorded; the page counts the larger and marks an agent the proxy saw clearly more of), and a check against what DeepSeek and OpenRouter actually billed (read by the daemon every 5 min into `costs.db`; each agent's own figures are also in its panel, COSTS) |
| `/system` | The host machine: CPU, memory and swap, storage per filesystem — current values and 1h / 24h / 7d / 30d history (from `metrics.db`, sampled by the daemon every 30 s); **Agents and containers**: what Docker holds on disk, and one row per container — CPU, memory, storage, processes — that opens to its own CPU / Memory / Storage charts (sampled every 60 s; a recently seen row without current statistics says "no data", and stale current figures are hidden; each agent's numbers are also in its panel, RESOURCES); and the recent alerts: the machine's CPU, memory and disks, plus a container with 1000 or more processes on two samples in a row or 90 % of Docker's memory on five (at most one alert per container and rule per hour) |
| `/wizard` | First-run setup wizard (Welcome → Providers → Agent → Ready) |
| `/workspace` | File explorer with tree view + editor — VPS host or container workspaces |
| `/lineage` | Agent lineage / orchestration tree |
| `/memory` | Agent memory browser |
| `/gateway` (model rows) | Each model has a **Details** (`⋯`) action opening a modal with what is known about it: description, price and the provider it comes from, architecture and parameters (mixture of experts, layers, hidden size, attention heads, vision encoder, precision, weights on disk), reasoning modes, capabilities, benchmarks with their sources, licence and popularity. The facts come from the model's card on Hugging Face and — for the vendor's own size claim and benchmarks — from hand-curated entries that always cite a source and a date; nothing is estimated. |
| `/crons` | Scheduled cron jobs — auto-discovered from the host gateway and every running agent container (Docker containers with `AGENT_ID` label), on/off toggle, run history per job |
| `/credentials` | Third-party tool credentials (GitHub, Trello, Vercel, Supabase, Notion) — SQLite vault, synced into agent containers as CLI config or, for the REST-only providers, as a config file the agent reads |
| `/setup` | First-run password setup — sets `REV4A_PASSWORD` and the JWT secret before the dashboard is reachable |
| `/plugins` | Plugin manager |
| `/skills` | Skill registry — browse/edit all skills (shared, per-agent workspace, bundled). Promote agent skills to shared with one click. |
| `/tools` | Tool configuration |
| `/gateway` | LLM provider keys, model catalogue and sync — see [GATEWAY.md](dev/GATEWAY.md) |
| `/config` | Environment management and server restart |
| `/login` | Authentication page |

---

## Authentication

Rev4a uses password-based login with JWT cookies.

**Env vars:**
```
REV4A_PASSWORD=***    # Login password
REV4A_TOKEN=***       # API token (sent as Authorization: Bearer; the browser uses the rev4a_token cookie)
REV4A_JWT_SECRET=***  # Secret for signing JWTs
```

**Auth flow:**
1. User visits `/login`, enters password
2. POST `/api/auth/login` validates password, returns a `rev4a_token` cookie (JWT, 7-day expiry)
3. All subsequent API calls use the cookie (`credentials: 'same-origin'`)
4. API-only auth: `Authorization: Bearer <REV4A_TOKEN>` (no query-string token is accepted)
5. Control UI bootstrap links should use `#token=<token>` so the browser client can import the shared secret before opening the socket

---

## Alerts (Telegram)

Rev4a can send Telegram alerts when the events database goes stale (no
recent writes — see `/api/system-health`). Implemented in `lib/alerts.ts`.

**Env vars:**
```
REV4A_ALERTS_ENABLED=false        # Master switch — no alerts sent unless "true"
REV4A_TELEGRAM_BOT_TOKEN=         # Telegram bot token
REV4A_TELEGRAM_CHAT_ID=           # Telegram chat to notify
REV4A_ALERT_COOLDOWN_MS=600000    # Minimum time between repeat alerts for the same condition
REV4A_ALERT_STALE_SECONDS=120     # How long without a DB write before the system is considered stale
REV4A_ALERT_SMOKE=false           # true enables GET /api/alerts/smoke (sends a test alert) in production
```

**Behavior:**
- If `REV4A_ALERTS_ENABLED` is not `"true"`, `maybeSendAlert` is a no-op — nothing is sent, nothing is recorded.
- If enabled but `REV4A_TELEGRAM_BOT_TOKEN` or `REV4A_TELEGRAM_CHAT_ID` is missing, alerts run in **dry-run**: state transitions are still recorded in the `alert_state` table (SQLite), but no Telegram message is sent — visible in server logs as `[alerts] dry-run`.
- Alert state (`ok` / `alerted` / `resolved`) is tracked per `alert_key` in `alert_state`, so a resolved condition sends a follow-up "✅ resolved" message instead of staying silent.
- `REV4A_ALERT_COOLDOWN_MS` prevents repeat-sending the same stale alert while the condition persists.

---

## Service Management

```bash
# Start
sudo systemctl start rev4a.service

# Stop
sudo systemctl stop rev4a.service

# Restart
sudo systemctl restart rev4a.service

# Status
sudo systemctl status rev4a.service

# Logs (follow)
sudo journalctl -u rev4a -f
```

### Start-up and Docker

`rev4a serve` waits for the Docker daemon before its Docker-dependent steps, up to
`REV4A_DOCKER_WAIT_SECONDS` (default 90, capped at 600; `0` checks once without
waiting; a negative or non-numeric value means 90). It asks the daemon itself with
`docker info`, so the wait works the same on any Docker install. The variable is
read from the process environment, not from the `.env` file.

If the daemon never answers, `serve` starts anyway, skips the network and image
checks, and says so in the log. The startup sync then reaches no agent, and logs
that too; run Sync All Agents once Docker is up.

### Memory (a host that runs several agents)

`rev4a update` installs the new version and the server rebuilds Next before it comes
back (the install's postinstall build, or a startup build when none exists). That build is the memory peak
of the whole installation: with several agent Gateways resident (roughly 0.5-0.8 GB
each) a host with no swap can hit the kernel OOM killer during the update — it killed
`next-server` on a 7.7 GB VPS, which then stayed unreachable until a reboot.

Give such a host swap (4-8 GB is enough for the build) and a conservative
`vm.swappiness`:

```bash
fallocate -l 4G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
echo 'vm.swappiness=10' > /etc/sysctl.d/99-rev4a-swap.conf
```

### Systemd environment override

File: `/etc/systemd/system/rev4a.service.d/override.conf` — a drop-in for the single
`rev4a.service` unit (`systemctl edit rev4a`). It is for the variables `.env` does not
carry: `rev4a serve` reads `~/.config/rev4a/.env` itself, and a key present there wins
over the same key set here — so secrets such as `REV4A_PASSWORD` or `REV4A_TOKEN`
belong in `.env` (or `/config`), not in the drop-in. It is also the only place for the
variables read before `.env` is loaded (`REV4A_DATA_DIR`, `REV4A_DOCKER_WAIT_SECONDS`).

```ini
[Service]
Environment=REV4A_DOCKER_WAIT_SECONDS=180
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
```

---

## Build & Deploy

```bash
cd /path/to/'rev4a'

# One command (builds + starts):
rev4a serve

# Manual build:
npm run build

# Full rebuild:
rm -rf .next && npm run build

# Production systemd (after setup script):
sudo systemctl start rev4a.service
```

> **Important:** API routes (`route.ts`) are compiled at build time by Next.js. After editing any API route, a full `npm run build` is required. Restarting the server alone is not enough.

---

## Workspace API (`/api/workspace`)

The workspace feature provides a file tree explorer + editor for both the VPS host and container workspaces.

### Parameters

| Method | Parameters | Description |
|---|---|---|
| `GET` | `?action=list` | List available workspaces |
| `GET` | `?workspace=vps` | List root files in VPS host workspace |
| `GET` | `?workspace=vps&path=<dir>` | List files in a directory |
| `GET` | `?workspace=vps&path=<file>` | Read file content |
| `PUT` | JSON `{workspace, path, content}` | Write/overwrite file |

### Workspaces

| ID | Label | Type | Path |
|---|---|---|---|
| `vps` | VPS Host (Nexus) | host | `/path/to/workspace/` |
| `container-<name>` | `<agent_id> (<name>)` | container | `/root/.openclaw/` inside container |

Container workspaces are discovered dynamically — any Docker container with an `AGENT_ID` label is listed.

### Implementation notes

- **Host:** uses `fs.readdirSync`, `fs.readFileSync`, `fs.writeFileSync` — real-time, no caching
- **Container:** uses `docker exec` with `ls -1Ap`, `test -d`, `cat`, and heredoc writes
- **Subdirectory expansion:** lazy-loaded via API when the user clicks a directory in the tree
- **Binary files (images, PDFs):** detected by extension, served as-is or displayed inline

---

## Features (current)

### Credentials (`/credentials`)
Store third-party service credentials and install them into agent containers.

- **SQLite storage:** `credentials.db` in the data directory. Secrets are held
  **unencrypted**; anything that can read the file has them in the clear.
- **Provider keys** are a separate store — `provider-keys.json`, managed from the
  Gateway UI.
- **Five providers.** GitHub, Vercel and Supabase are handed to their CLI —
  `gh auth login --with-token`, `~/.local/share/com.vercel.cli/auth.json`,
  `supabase login --token`. Trello and Notion have no CLI in the loop: their
  credentials are written to `~/.config/trello/config.json` and
  `~/.config/notion/config.json`, and TOOLS.md tells the agent how to call each
  REST API with them.
- **Delivery is explicit.** A credential reaches a container only on sync, and
  leaves only on de-sync. There is no per-agent permission model: any stored
  credential can be synced to any container.
- **Live detection** shows which credentials are actually installed, matching
  SHA-256 hashes of the tokens found in each container against the stored ones.

### Container management (`/containers`)
View all running Docker containers with:
- Name, image, status, ports, uptime
- Resource usage now (CPU share, memory, processes) for each running container, with *Charts →* to its history on `/system`
- Quick links to agent control UIs

### Agent management (`/agents`)
Lists all agents (Docker containers with `AGENT_ID` label), with:
- Name, image, template, status, ports, IP
- TG channel status chip (green = connected, hidden if not configured)
- **Shared gateway token** — text input with Save & Sync. Changing the token saves it to `data/agents-token.json` and pushes it to all running containers.
- **Control UI link** — the **Open** buttons go through `GET /api/agents/[id]/open-control-ui`, which redirects to the agent's published port on the host the dashboard was reached on: a one-time link on OpenClaw 9.x, the plain `#token=` link otherwise, with the token read inside the container.
- **Agent creation wizard** — multi-step form at `/agents/create`.
- **Channel Manager** — each agent detail panel has a Channels section with Telegram configuration and pairing management. Pending requests (a sender's `/start` creates one) show an **Approve** button; approved senders show **Revoke** with a confirmation. Approved senders are OpenClaw's pairing store, not the agent config: on 2026.9.x the SQLite store, read and revoked through OpenClaw's own store functions (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Browser access** — the detail panel section right after Channels. From OpenClaw 9.x each new browser must be approved once before the Control UI connects: the section lists requests waiting for approval (Approve / Reject) and approved browsers (Rename / Revoke), and the agent card shows a "browser waiting" badge. The **Open** buttons first ask the agent for a one-time link that pairs the browser with no approval, and open the plain token link when none can be issued (the agent is stopped, or the link fails). **Invite link** gives a link to send to someone else: their browser passes gateway auth and waits in the approval list until approved. The link carries the gateway token every agent shares; changing the agents token invalidates every link sent. All of it runs the OpenClaw CLI inside the container asynchronously.

### Agent Creation Wizard (`/agents/create`)

**Step 1 — Template:** Select an agent template from `agent-templates/`. Each template is a directory with AGENTS.md, SOUL.md, MEMORY.md, and optionally BOOTSTRAP.md files.

Available templates:
- **Atlas** — general-purpose development agent
- **Argus** — security and audit agent
- **Prometheus** — client-facing project delivery agent
- **Custom** — blank slate. On first run, the agent runs a bootstrap ritual: introduces itself, learns who the user is, and together they define name, personality, tone, and boundaries. The agent writes SOUL.md, IDENTITY.md, and USER.md, then deletes BOOTSTRAP.md. No preset identity, fully user-defined.

**Step 2 — Config:** Enter agent name, optional port, select a primary model from the available providers (pre-filtered by configured provider keys). The first model is pre-selected.

**Step 3 — Deploy:** `POST /api/agents/create` creates the Docker container and returns its port and the shared gateway token; the wizard links to `http://<host>:<port>#token=<token>`.

**Post-creation pipeline:**
1. The container boots with the newest supported OpenClaw version downloaded here, `openclaw-agent-base:<version>`; the create answers `409` when none is — see [Agent Templates](#agent-templates) below.
2. OpenClaw gateway starts automatically with `--allow-unconfigured`, generating its own default config.
3. The route waits for the gateway to finish starting with `waitForGatewayReady()`, up
   to 60 s: `/startupz` has to report `started`. A 503 (starting or draining), a
   non-JSON 200 or no answer all mean "not yet".
4. Once ready, the route writes:
   - `gateway.controlUi` with the browser-origin policy (`withControlUiPolicy()` in `lib/agent-setup.ts`): the Host-header fallback on, so the Control UI is accepted from the host the browser connected to — a public IP is refused without it — while pages from other origins are refused; an `allowedOrigins: ["*"]` list and the retired `dangerouslyDisableDeviceAuth` are dropped, any other allowlist is kept. Recreate re-applies the policy. Each new browser still needs a one-time device approval
   - `agents.defaults.model.primary` + fallbacks — the primary model selected in the wizard
5. The route builds `models.providers.rev4a` with `buildRev4aProviderConfig()` and writes it with `openclaw config patch --stdin`.
6. The agent's Control UI is reachable at `http://<host>:<port>#token=<gateway-token>`. For HTTPS or a domain, put your own reverse proxy in front of the published port: Rev4a sets no reverse-proxy labels on agent containers.

---

## Agent persistence & lifecycle

Each agent is created with a **persistent Docker volume** `agent-<name>-data`
mounted at `/root`. This cleanly separates two planes:

- **Software → image.** OpenClaw, `gh`, `vercel`, `supabase`, `trello`, Node — all
  live in the agent image `openclaw-agent-base:<version>` (outside `/root`). A recreate
  keeps the agent's OpenClaw version; moving an agent to a newer version is a separate
  update.
- **Data → volume.** Config (`openclaw.json`), state DB (`openclaw.sqlite`),
  workspace files, and CLI credentials (`.config/gh`, `.local/share/com.vercel.cli`,
  `.supabase`, …) live in `/root` and survive container removal.

On create, template files are copied into the workspace **only if it is empty** —
a re-created agent keeps the workspace the user edited.

**Lifecycle actions** (see [API Reference](dev/API-REFERENCE.md) for endpoints):

| Action | What it does |
|---|---|
| **Backup** | `tar` of `/root` (excl. npm cache) → `.tar.gz` in the `rev4a-backups` volume, while the agent runs |
| **Cold backup** | stop → archive `/root` (excl. npm cache) as `.partial` in a helper container → read the archive back → rename → start again if it was running. Other operations on the agent answer 409 meanwhile. Survives a Rev4a restart. API only for now (`/api/agents/[id]/cold-backup`) |
| **Update** | the agent panel's OPENCLAW VERSION section, when a newer supported version is downloaded: count transcript events and cron jobs → cold pre-update backup → recreate on the new version (its data migrates one way) → wait for that version → check nothing went missing. Unused agent images are removed afterwards |
| **Rollback** | after an update: stop → restore the pre-update backup → recreate on the previous version. Everything since the backup is lost |
| **Restore** | stop → replace `/root` with the backup (real wipe incl. dotfiles) → restart. Software/image untouched — only data goes back in time |
| **Recreate** | auto-backup first (aborts if it fails) → rebuild on the agent's own OpenClaw version (`openclaw-agent-base:<version>`, tagged or pulled when missing) keeping the volume. Never changes version |
| **Restart** | `docker restart`, nothing else |
| **Delete** | **destructive**: removes container **+ volume + all backups**. Cannot be undone |

Version migrations after an image update are handled by the entrypoint (see
[Entrypoint behavior](#agent-templates)), not by `openclaw update` — updating an
agent means rebuilding the image + Recreate, never `update` inside the container.

---

## Agent Templates

### Base Image (`openclaw-agent-base:<version>`)

**Dockerfile:** `agent-templates/base-image/Dockerfile`

**Versions.** Images are kept locally per OpenClaw version, `openclaw-agent-base:<version>`;
`:latest` is not used. The versions this release supports, newest first, and the model
`input` list for each, are in `lib/agent-versions.json`, read by the server and the
`rev4a` CLI. The Agents page banner offers the newest supported version the registry
publishes (`ghcr.io/flame0510/rev4a/openclaw-agent-base`, or `REV4A_AGENT_IMAGE_REGISTRY`);
downloading touches no agent. Create uses the newest supported version downloaded; recreate
keeps the agent's version, and moves it to the build this release pins for that version: the
version is read from the image label even when the image lost every tag, so a recreate of a
stopped agent on an untagged image still lands on `openclaw-agent-base:<version>`. An agent card shows **UPDATE AVAILABLE** when a newer supported
version is downloaded, else **NEW BUILD** when the pinned build of the agent's version is downloaded
and the agent runs another image; the agent panel's RECREATE section then shows a yellow note above its
**Recreate Container** button (a cold backup first). At every start Rev4a gives each agent image
that has no `openclaw-agent-base:` tag but a version label the identity tag
`openclaw-agent-base:<version>-rev.<12 hex of the image id>` (best effort, idempotent, nothing is removed), so
the image is listed and retention can remove it once unused.

**Image revisions.** A rebuild of a version keeps its `<version>` tag, so an entry in
`lib/agent-versions.json` may pin `imageRevision` (a short sha): the registry's immutable
`<version>-<sha>` tag. The download then pulls that tag and tags it locally
`openclaw-agent-base:<version>` and `openclaw-agent-base:<version>-rev.<sha>`; the local
`<version>` image is that revision when the same image id also carries the `-rev.<sha>`
tag (`-rev.` keeps an all-digit sha from parsing as part of a version). A local image
without the tag, or with another revision, is *outdated*: the banner offers the new build.
Agents keep the image they run; an agent moves to the new build only when it is created or
recreated (Update moves an agent to a newer OpenClaw version, not to a new build of the same one). No pin, or `REV4A_AGENT_IMAGE_REGISTRY` set, means the
version alone decides, as before. A locally built fallback image carries no revision tag.

If the pinned build cannot be downloaded: when the version already exists locally the
download fails with "The pinned build <version>-<sha> could not be downloaded: <error>",
no local build is attempted and no tag moves, so the existing image stays. When the version
is missing locally, the local build fallback still runs so the install works; its outcome
says it was built locally because the pinned build could not be downloaded, and the status
stays *outdated*. When a pinned download replaces a different image under `<version>`,
the previous image is first tagged `<version>-rev.<first 12 hex chars of its image id>` (if
it has no `-rev.` tag), so it stays listed; retention removes it once no container uses it.
An image with several `-rev.` tags is *current* when any of them is the pinned revision.

Built from `node:24-bookworm-slim`, includes:
- OpenClaw, pinned by the `OPENCLAW_VERSION` build argument and recorded as the
  `org.opencontainers.image.version` label
- `gh`, `vercel`, `trello`, `supabase`
- Plugins under `/opt/openclaw-plugins`, outside the agent volume and pinned to the same
  OpenClaw release: DuckDuckGo web search
- `openssl` (for local token generation)
- Durable apt installs: `rev4a-apt` (as `/usr/local/sbin/apt-get` and `apt`) and `rev4a-packages-restore`, see below
- `/root/.local/bin` on `PATH`, after the system directories
- Custom entrypoint `/agent-entrypoint.sh`

See also [agent-templates/README.md](../agent-templates/README.md).

**Entrypoint behavior:**
- Resolves the auth token (file > env > local random)
- Does NOT generate `openclaw.json` — OpenClaw creates its own default config on first boot
- **Version-gated migration:** if the OpenClaw version differs from the one recorded in
  `/root/.openclaw/.last-version` (a newer image, or a new volume), runs
  `openclaw doctor --fix --non-interactive` **before** starting the gateway. `--fix` is
  required from OpenClaw 9.x: the agent database schema is migrated only with the gateway
  stopped, and the gateway refuses the old schema rather than migrating it. The version is
  recorded only after a successful run, so a failed migration is retried on the next boot.
  A failure does not block boot.
- **Image defaults**, before the gateway starts, at every start, written only where missing
  (so existing agents get them when they are recreated onto the image, and a
  long transcript is compacted for the first time then):
  - the image's plugin directories in `plugins.load.paths`
  - `tools.web.search.provider: "duckduckgo"` when no provider is set
  - `agents.defaults.heartbeat.every: "0m"` when unset: every heartbeat tick is a
    model-calling turn, so the recurring cadence is opt-in
  - `agents.defaults.compaction.maxActiveTranscriptBytes: "20mb"` when unset: a run
    compacts before the model-visible transcript grows past that, so a long-lived session
    cannot keep inflating memory and cost
  - `agents.defaults.contextPruning` set to `{mode: "cache-ttl", ttl: "1h"}` when `mode` is
    unset: old tool results are trimmed from the in-memory context before each request. The
    patch sets both `mode` and `ttl` (other `contextPruning` keys are kept: `openclaw config
    patch` merges objects), so a `ttl` set without a `mode` is replaced by `1h`

  Any other explicit value, such as a heartbeat turned on for one agent, is never overwritten.
  The config is read with one node process and written through `openclaw config patch`,
  which validates; if `openclaw.json` cannot be read as JSON, the defaults are skipped and
  the log says so.
- **Durable apt installs**, in the background just before the gateway (it never waits for
  apt): `rev4a-packages-restore` puts back the apt sources and keyrings saved under
  `/root/.rev4a/apt/`, finds the packages of `/root/.rev4a/packages.txt` that dpkg no longer
  has (a recreate, an OpenClaw update or a restore starts from a fresh container layer; a
  plain restart keeps it and ends at once), runs `apt-get update` and installs each as
  `name=version`, or as `name` when that version left the repository, with the real
  `apt-get`; the whole run is bounded to 15 minutes, and the bare-name fallback happens only when apt says the exact version is not available (a lock or network error is a failure). The list is written by `rev4a-apt`, which stands in for
  `apt-get` and `apt`: after a successful `install` it records the packages named on the
  command line (not dependencies; not simulations or local `.deb` files) with their installed
  version, and saves the apt sources and keyrings that are not part of the image, plus the key files they name with `signed-by` / `Signed-By:` (absolute files outside `/root`; restored never overwriting); a
  successful `remove` or `purge` drops the entry. A recording failure is one stderr line and
  never changes the exit code. The result is `/root/.rev4a/packages-status.json`
  (`state`: `running` while it works, then `ok`, `partial`, `failed` or `nothing-to-do`; `restored`, `versionChanged`,
  `failed`). Upgrade: an agent recreated onto this image has no list yet, so nothing happens
  and what it installs from then on is recorded; packages installed before this image are
  lost at that recreate, as before; offline, the packages are reported `failed` and the next
  boot tries again; rolling back to an older image leaves the list on the volume, unused.
  Tools installed other than with apt (`npm -g`, `pip`, a binary) must live under `/root`
  (`/root/.local/bin` is on `PATH`); the agent rules say so.
- **Durable apt restore limits**: the restore writes back only saved paths under `/etc/apt/` and `/usr/share/keyrings/` plus key files named by a saved source (`signed-by` / `Signed-By:`, including deb822 continuation lines); anything else on the volume is ignored with a log line. It runs `dpkg --configure -a` first when dpkg was left half-configured. The recorder's list lock is stale after 60 s whatever its pid.
- Starts OpenClaw gateway with `--allow-unconfigured`: `openclaw gateway --bind lan --port 3000 --auth token --token "<token>" --allow-unconfigured`
- Everything else (controlUi, model refs, providers) is handled by the create route and the Gateway sync module

### Template directories
Located in `agent-templates/`. Each subdirectory (e.g. `atlas/`, `custom/`) contains:
- `AGENTS.md`, `SOUL.md`, `IDENTITY.md`, `MEMORY.md`, `TOOLS.md`, `HEARTBEAT.md`
- `BOOTSTRAP.md` (optional) — first-run ritual, deleted by the agent when complete

At container creation these files are **copied** into `/root/.openclaw/workspace/`
via `docker cp` (not bind-mounted), so agent edits never spill back to the Rev4a
repo. The copy is skipped when the workspace is already populated (see
[Agent persistence](#agent-persistence--lifecycle)).

---

## Gateway Page (`/gateway`)

One job: provider configuration. API keys, which catalogue models this deployment
offers, and pushing that catalogue to every agent.

For DeepSeek models, each model row shows the current peak/off-peak band and its
current rate. An open page refreshes those figures after the next band change.

- Reads the model catalogue from `models.config.json`, merged with user toggles in
  `<data dir>/model-overrides.json`
- Scans providers with keys in `<data dir>/provider-keys.json`
- `PUT /api/gateway/provider` runs `syncAllAgents()`, which writes
  `models.providers.rev4a` into every agent container
- **Does NOT touch** `agents.defaults.model` or `agents.list[].model` — those are
  per-agent settings

### Per-agent model, elsewhere

Choosing which model one agent runs is not on this page. It lives in the Model
section of that agent's detail panel on the Agents page
(`app/agents/ModelSection.tsx`), which calls `PUT /api/gateway/agent` to write the
model ref into that container's `openclaw.json`. No gateway restart: OpenClaw
watches the file and hot-applies the change.

The model is a property of the agent, not of the gateway. See
[GATEWAY.md](dev/GATEWAY.md) for the write semantics: omitting `fallbacks` keeps the
agent's current list, `[]` clears it.

### Model Catalogue (`models.config.json`)
File-based, tracked in git. Each entry:
```json
{ "id": "deepseek/deepseek-flash", "name": "DeepSeek Flash", "provider": "deepseek", "enabled": true }
```
Models with `enabled: false` are ignored.
Only models whose provider has a key in `data/provider-keys.json` are synced.

---

## Key Gotchas

1. **`auth.mode: "none"` + `0.0.0.0:3000`** → OpenClaw refuses to bind. Must be `auth.mode: "token"`.
2. **Control UI password** is the `gateway.auth.token`, not an env var.
3. **API routes need full build** — after editing `route.ts`, run `npm run build`. Server restart alone is not enough.
4. **Container directory listing** uses `docker exec` with `ls -1Ap` (single line per entry, trailing `/` on directories). Do NOT use `ls -la` with regex parsing.
5. **Subdirectory detection** for containers: `docker exec … test -d "$path" && echo YES || echo NO` before deciding to list or read.
6. **Service worker cache** (`public/sw.js`): if stale versions appear in the browser, delete this file and rebuild. Currently removed.
7. **Browser cache on workspace page:** the API uses `cache: 'no-store'` but the browser may still cache the rendered page. Use hard refresh (Ctrl/Cmd+Shift+R) or incognito mode to verify.

---

## Troubleshooting

### Workspace shows old files
1. Hard refresh (Ctrl/Cmd+Shift+R)
2. Open incognito/private tab
3. Check API directly: `curl -H "authorization: Bearer <token>" 'http://127.0.0.1:3740/api/workspace?workspace=vps'`

### API returns 500
- For VPS: check file permissions on the workspace path
- For containers: `docker exec` may fail on certain directories

### "Empty workspace"
- Verify the API returns files (test with curl)
- Ensure the `workspace` parameter is a valid workspace ID

### Old version persists after rebuild
1. Kill process: `fuser -k 3740/tcp`
2. Wait 2 seconds
3. Restart: `sudo systemctl restart rev4a.service`
4. Check `public/sw.js` exists (delete if so)

---

## API Test Commands

```bash
# Login (get cookie)
curl -c /tmp/cookies.txt -X POST http://localhost:3740/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"password":"***"}'

# List workspaces
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?action=list'

# List VPS workspace files
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?workspace=vps'

# List Atlas container files
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?workspace=container-openclaw-atlas'

# Read a file
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?workspace=vps&path=/path/to/workspace/SOUL.md'

# Write a file
curl -b /tmp/cookies.txt -X PUT http://localhost:3740/api/workspace \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"vps","path":"/path/to/workspace/test.md","content":"hello"}'
```

---

## Repository Structure

```
/path/to/rev4a/
├── app/                     # Next.js app router pages & API routes
│   ├── agents/
│   ├── api/                 # API routes (workspace, agents, vault, auth, …)
│   ├── components/          # Reusable React components
│   ├── containers/
│   ├── dashboard/
│   ├── login/
│   ├── memory/
│   ├── plugins-skills/
│   ├── skills/
│   ├── tools/
│   ├── vault/
│   └── workspace/
├── docs/                    # Project documentation
│   ├── REV4A.md           # This file — operational docs
│   └── ARCHITECTURE.md      # Design & future vision
├── lib/                     # Shared utilities (apiFetch, vault, memory-context)
├── public/                  # Static assets
├── scripts/                 # Utility scripts (setup, helpers)
├── .env                     # Local env vars (gitignored)
├── proxy.ts                    # Auth gate — redirects to /login without a valid JWT cookie
├── next.config.mjs
└── package.json
```
