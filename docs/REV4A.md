# Rev4a — VPS Dashboard

> **Last updated:** 2026-10-13

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
| `REV4A_ROOT` | No | Installation root, used by `rev4a update` to detect a git checkout |
| `REV4A_TIMEZONE` | No | Default dashboard time zone (IANA name), used only while none is saved in *Config > Time zone*; a saved zone wins, and with neither the server's own zone is used |
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
| `/` | System overview — health, sessions, the machine's CPU / RAM / disk (links to `/system`), what the agents spent today (the agents' own figures, without ChatGPT subscription calls; `/costs` can show more, see below), live feed |
| `/agents` | Running agents (Docker containers with `AGENT_ID`), gateway token management, agent creation wizard, channel manager (Telegram pairing). On a phone the page scrolls in one region (banners, the Gateway Token form, then the list); each agent is an `AgentCard` with the status switch, name, Open Control UI, image/ports, model and status chips (STARTING with the elapsed time while an agent's Gateway boots, NOT READY after 10 minutes); Open is disabled only while the Gateway is starting (after 10 minutes NOT READY shows and Open is enabled again) |
| `/containers` | All Docker containers on the host, each running one with its CPU, memory and processes now (from the daemon's container samples) and a link to its charts |
| `/costs` | What each agent spent, as its own OpenClaw priced it with the rates Rev4a syncs: today / 7 / 30 UTC days, by day, by agent, by model, the most expensive sessions, the calls that could not be priced, the DeepSeek band now, **metered at the proxy** next to **recorded by the agent**, per agent (the proxy counts every call it carries, the agent only what it recorded; the page counts the larger and marks an agent the proxy saw clearly more of), and a check against what DeepSeek and OpenRouter actually billed (read by the daemon every 5 min into `costs.db`; each agent's own figures, the ones Home's "Spent today" shows, are also in its panel, COSTS). Spent on this page is the larger of the two figures per agent, so it can be higher than Home's; calls without an agent header ("Unidentified callers") are listed but not counted in Spent. Calls made with a ChatGPT subscription (provider `openai`, or the legacy `openai-codex`) are covered by the plan: they are in no spend figure and have their own section, **ChatGPT subscription** (shown only when the range has some): tokens, calls and the **API value** — what the same calls would have cost at OpenAI API prices (OpenClaw's price catalog, refreshed every 6 hours) — by agent and by model; a model with no price shows "no price" (never $0) and the headline then says "at least"; it links to `/subscriptions` for the quota windows |
| `/system` | The host machine: CPU, memory and swap, storage per filesystem — current values and 1h / 24h / 7d / 30d history (from `metrics.db`, sampled by the daemon every 30 s); **Agents and containers**: what Docker holds on disk, and one row per container — CPU, memory, storage, processes — that opens to its own CPU / Memory / Storage charts (sampled every 60 s; a recently seen row without current statistics says "no data", and stale current figures are hidden; each agent's numbers are also in its panel, RESOURCES); and the recent alerts: the machine's CPU, memory and disks, plus a container with 1000 or more processes on two samples in a row or 90 % of Docker's memory on five (at most one alert per container and rule per hour) ; a **Memory limit** warning appears only when the running containers use 85 % or more of Docker's memory and a running agent has no limit or its limit could not be read; Recent alerts also lists `container_oom` (a process killed for lack of memory in an agent) |
| `/config` (Agent defaults) | Besides the environment variables, a *Default memory limit for new agents* picker, **No limit by default**. It only prefills the create wizard's memory limit; it never changes an agent that exists (`agent-defaults.json`, `GET`/`PUT /api/agent-defaults`) |
| `/config` (Time zone) | A *Time zone* card: the zone the dashboard shows times in (Costs, System, Crons, Memory, the header clock, the live feed and the session drawer). Until one is saved it is **Server default (<zone>)**; *Use server default* forgets a saved one. Saved on its own (`settings.json`, `GET`/`PUT /api/settings`), applies at once |
| `/wizard` | First-run setup wizard (Welcome → Providers → Agent → Ready) |
| `/workspace` | File explorer with a lazy tree (one folder at a time, "Show hidden files" switch, lock badge on read-only places, `?agent=&file=&hidden=` in the URL) + editor — agent container workspaces; a banner appears when the agent changes the open file; PDF, images, SVG, audio and video open read-only; logs and files over 2 MB open on their last 256 KB (read-only, "Load earlier"); every file has a Download button; a save never overwrites a newer version from the agent without asking |
| `/lineage` | Sessions of every agent container as a tree: container (stopped ones marked) → `main` → sessions → sub-agents (any depth) → cron runs, with OpenClaw's real status, model, tokens and cost ("not priced" when unknown). Filters: agent, period, active only, no cron. Click a node for the session drawer. |
| `/memory` | Context: per agent, read-only, what OpenClaw injects into the prompt (size, truncation against the caps), the `memory/` files and the Rev4a rules file; file names open in Workspace |
| `/gateway` (model rows) | Each model has a **Details** (`⋯`) action opening a modal with what is known about it: description, price and the provider it comes from, architecture and parameters (mixture of experts, layers, hidden size, attention heads, vision encoder, precision, weights on disk), reasoning modes, capabilities, benchmarks with their sources, licence and popularity. The facts come from the model's card on Hugging Face and — for the vendor's own size claim and benchmarks — from hand-curated entries that always cite a source and a date; nothing is estimated. |
| `/crons` | Scheduled cron jobs — auto-discovered from every running agent container (Docker containers with `AGENT_ID` label), on/off toggle, run history per job; agents are shown by display name |
| `/credentials` | Third-party tool credentials (GitHub, Trello, Vercel, Supabase, Notion, MongoDB) — SQLite vault; each credential has a switch per agent that delivers it through OpenClaw (environment entries and skill config for Trello, Notion and Supabase, a connection string plus `mongosh` and a shared skill for MongoDB, the managed GitHub identity, the Vercel CLI's own files) |
| `/subscriptions` | ChatGPT (Codex) accounts per agent: connect an agent by device code (Rev4a shows a link and a code, you enter the code on OpenAI), see until when each agent is connected, see the account's usage limits (5 hours and weekly, with reset times), see the model each agent uses (read-only, with a link to the agent panel where it is chosen), disconnect. The tokens stay in the agent's volume; Rev4a stores nothing |
| `/setup` | First-run password setup — sets `REV4A_PASSWORD` and the JWT secret before the dashboard is reachable |
| `/plugins` | Plugins of each agent, read from its container (read-only; agent selector, search, enabled filter) |
| `/skills` | Skill registry — browse/edit all skills (shared, per-agent workspace, bundled). Promote agent skills to shared with one click. Rev4a's own skills (`rev4a-*`) show "Managed by Rev4a" and are read-only. |
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
2. POST `/api/auth/login` validates password, returns a `rev4a_token` cookie (JWT, 7-day expiry). Wrong passwords are throttled per client address: the first 5 wrong passwords in an hour are free, and from the 6th the address is locked for 30 s, doubling with each further failure up to 15 minutes (`429` + `Retry-After`; the login page shows the wait and disables the button). While an address keeps failing, its lock stays at the level it reached; it starts again from zero after an hour without a failure. A restart of Rev4a resets the counters. The address is the socket peer, an IPv6 one reduced to its /64. `X-Forwarded-For` is trusted **only** from peers listed in `REV4A_TRUSTED_PROXIES` (comma-separated IPs or CIDRs, e.g. `192.0.2.10`; invalid entries are ignored with a warning at start-up, and a very wide range such as `0.0.0.0/0` is accepted with a warning). With the variable unset no peer is trusted, loopback included, so agent containers, LAN clients and local processes are keyed by their own address. Behind a reverse proxy, set `REV4A_TRUSTED_PROXIES` to the proxy's address (`127.0.0.1,::1` for a proxy on the same host) and make the proxy **append or overwrite** `X-Forwarded-For` with the real client address (Traefik and Caddy do by default; nginx needs `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`); the rightmost entry is then the key. Listing loopback trusts every local process. On Docker Desktop (macOS/Windows) containers reach the host from 127.0.0.1, so listing 127.0.0.1 there lets agents choose their key: prefer a proxy with its own distinct address, or accept the risk. When the proxy runs in Docker, list its own address and PIN it (a static `--ip` / `ipv4_address` on a network dedicated to the proxy and Rev4a); do not put the proxy on `rev4a-network` with the agents, because Docker assigns addresses dynamically and after a restart an agent can take the proxy's old address and be trusted. Listing a whole agent network lets any agent pick its own key. Failure mode: a proxy that is not listed, or a listed proxy that sends no `X-Forwarded-For` (a same-host one over `::1` shares `::/64`), puts every visitor under one key. While an attacker sharing the owner's key keeps trying, the owner stays locked out; after the attacker stops, one owner typo within the hour still costs up to 15 minutes (the peak rule). To recover, restart Rev4a (`sudo systemctl restart rev4a` on a systemd install, or restart `rev4a serve`).
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

### Updating Rev4a itself

**Update now** (or `rev4a update` from a shell) covers every open tab with a full-screen
"Updating Rev4a" screen: the current phase (installing, building, restarting), from → to,
elapsed time and the tail of `update.log`. It reloads on its own when the new version
answers. If the update fails it shows the error and the log with Retry, Reload and
Dismiss. On an npm install the build runs inside the "installing" phase (npm's postinstall);
"building" shows for a git checkout or a fallback build. While it runs the server refuses
every mutating API call (`503 Rev4a is updating`, the PULSE chat included); reads and the
agents' provider proxy keep working. A `rev4a update` from a shell with nothing to install
checks the registry, prints that it is up to date and does not show the screen. `rev4a update` records its phases in
`update-state.json` next to `update.log`; a state older than 30 minutes no longer counts, and
an updater that died (or a restart that has not happened after 5 minutes) turns into the
failure screen, which Dismiss closes — writes are no longer refused then. Only one update runs at a time: a second `rev4a update`
(or a second click) is refused while one is in progress. "The new version answers" means
the version the server process runs, not the `package.json` npm has already replaced. There is no automatic rollback: a failed update leaves the
previous version running when the failure came before the restart, and the error and
`update.log` say what to do. See `docs/dev/API-REFERENCE.md` (`GET /api/update-status`).

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

The workspace feature provides a file tree explorer + editor for the agent containers' workspaces. There is no host ("Local") workspace; `REV4A_WORKSPACE_ROOT` is ignored. Full detail in [dev/WORKSPACE.md](dev/WORKSPACE.md).

### Parameters

| Method | Parameters | Description |
|---|---|---|
| `GET` | `?action=list` | List agent workspaces (running and stopped) and `dockerAvailable` |
| `GET` | `?workspace=container-<name>&tree=1` | Recursive tree of the agent's workspace |
| `GET` | `?workspace=container-<name>&path=<dir>&list=1[&hidden=1]` | One level of a folder (the page's lazy tree), up to 5,000 entries, `truncated` when more |
| `GET` | `?workspace=container-<name>&path=<file>&stat=1` | `{ path, size, mtimeMs, kind }` without reading the file |
| `GET` | `?workspace=container-<name>&path=<dir>` | List files in a directory |
| `GET` | `?workspace=container-<name>&path=<file>` | Read a text file (up to 2 MiB); answers `content`, `size`, `mtimeMs` |
| `GET` | `?workspace=container-<name>&path=<file>&tail=<bytes>` | The last bytes (default 256 KiB, max 2 MiB) of a text file of any size, with `offset`, `length`, `truncated` |
| `GET` | `?workspace=container-<name>&path=<file>&offset=<n>&length=<m>` | A byte range (max 2 MiB), cut on UTF-8 boundaries |
| `GET` | `?workspace=container-<name>&path=<file>&info=1` | `{ size, mtimeMs, kind, label? }` from the first 4 KiB (magic-number label) |
| `GET` | `?workspace=container-<name>&path=<file>&download=1` | The exact bytes of any regular file up to 50 MiB as an attachment |
| `GET` | `?workspace=container-<name>&path=<file>&raw=1` | The exact bytes of a PDF, image, SVG, audio or video file (up to 50 MiB), for the browser's own viewer |
| `PUT` | JSON `{workspace, path, content, expectedMtimeMs?}` | Write/overwrite a file (exactly `content`); with `expectedMtimeMs`, a file changed by the agent in the meantime answers 409 and is left alone. Answers `{ ok, mtimeMs }` |

The list also gives each workspace its `readOnlyPaths`. Errors are JSON `{error}` with a real status: 400 bad id or path, 403 outside the workspace root, 404 not found, 409 save conflict, 413 over 2 MiB (50 MiB in raw mode), 415 not UTF-8 text (raw mode: type not served), 423 read-only location, 502 agent not running, 503 Docker not available.

### Workspaces

| ID | Label | Type | Path |
|---|---|---|---|
| `container-<name>` | the agent's name, else `<agent_id> (<name>)` | container | `/root/.openclaw/workspace/` inside the container |

Container workspaces are discovered dynamically — any Docker container with an `AGENT_ID` label is listed.

### Implementation notes

- **Container:** `docker exec` with argv arrays (`find`, `stat`, `realpath -m`, `cat`), never a host shell; saves send the content on stdin to a constant script that writes atomically. Helpers in `lib/workspace-fs.ts`.
- **Confinement:** paths are checked against the workspace root after `..` and symlinks.
- **Subdirectory expansion:** lazy-loaded via API when the user clicks a directory in the tree
- **Binary files:** never opened as text or saved. `raw=1` serves PDF, images, SVG, audio and video to the browser's own viewer (up to 50 MiB, read-only); `download=1` gives the exact bytes of any regular file (up to 50 MiB) as an attachment; `info=1` labels a file from its first 4 KiB (SQLite database, ZIP archive, PNG...). Any other binary file shows its type and size and a Download link.

---

## Features (current)

### Credentials (`/credentials`)
Store third-party service credentials and install them into agent containers.

- **SQLite storage:** `credentials.db` in the data directory. Secrets are held
  **unencrypted**; anything that can read the file has them in the clear.
- **Provider keys** are a separate store — `provider-keys.json`, managed from the
  Gateway UI.
- **Six providers.** GitHub, Trello, Vercel, Supabase, Notion and MongoDB. A credential reaches an
  agent the native OpenClaw way: the token is written to the agent's OpenClaw **secret
  store** as environment entries (`SUPABASE_ACCESS_TOKEN`, `TRELLO_API_KEY` and
  `TRELLO_TOKEN`, `NOTION_API_TOKEN`) and the matching bundled skill is configured
  (`skills.entries`: a SecretRef `apiKey` for Notion, an `env` map for Trello, a plain
  switch-on for GitHub) so it turns eligible by itself. Rev4a writes no TOOLS.md row; the
  agent finds the service available from its environment and its skills. `supabase` reads
  its variable natively.
- **MongoDB is a connection string plus a CLI.** The string (`mongodb://` or `mongodb+srv://`, checked when it is saved) goes into the secret store as `REV4A_MONGODB_URI`: the usual name `MONGODB_URI` is dropped by OpenClaw's exec tool on purpose, so it would never reach a command. Switching it on, in this order: installs `mongosh` 2.13.0 under `/root/.local` in the agent (about 200 MB, so the first switch-on can take a few minutes; skipped when that version is already there; another version or a missing launcher is reinstalled; 5 minutes allowed; on failure nothing else is written), puts Rev4a's shared skill `rev4a-mongodb` in the host's shared skills directory, writes the store entry and the skill entry (SecretRef `apiKey`), reloads, and asks `openclaw skills info rev4a-mongodb --json` whether the skill is eligible. If it is not (or the answer cannot be read) the switch-on fails and the store and skill entries are removed again. If the check times out, the switch-on also fails but nothing is rolled back (the state is unknown); switch it on again to retry. The skill is hidden from the model on agents where the credential is off. Switching off removes the store entry and the skill entry; `mongosh` stays installed. Rev4a never tests the connection: the variable exists only inside commands run by OpenClaw's exec tool. Read-only access comes from the database user's built-in read role, not from Rev4a; the Credentials page says so. An agent row shows `mongosh <version>`, or "mongosh missing — switch MongoDB off and on" when the credential is held and no mongosh was found.
- **GitHub and Vercel are special.** OpenClaw drops `GH_TOKEN` and `GITHUB_TOKEN` (they are
  reserved environment overrides), and the Vercel CLI ignores a token-only environment (for a
  `northstar` account it forces the account default team). GitHub is delivered as OpenClaw's
  **managed GitHub identity** — a one-use handoff plus `tools.github.configure`, which keeps
  only a `tools.github.profileId` in config — and Vercel through the CLI's own `auth.json` +
  `config.json {currentTeam}`, with an accessible team discovered from the Vercel API. `config.json` is always rewritten, without `currentTeam` when no accessible team is found, so a team left by an earlier delivery never survives. A failed GitHub enable, and a switch-off, remove any `github-setup-*` handoff left in the secret store. Vercel and GitHub are held to the same OpenClaw version floor as the others. Gateway CLI calls use the token from `/root/.agent-token` when present, so they keep working after a token rotation.
- **Per-agent switch.** Each credential lists the agents with a **Switch**, with Rev4a's intent stored in `credential_assignments`. One credential per provider is active
  on an agent: switching on another profile of the same provider replaces the first.
  Each row shows the switch and, when needed, **Redeliver**, **Remove** or **Retry removal**. A credential enabled in Rev4a but missing from the agent says "Not found in the agent"; an unreadable provider shows an unknown state (`?`) and Rev4a's setting. A stopped or busy agent shows a disabled switch with the reason.
  When the page cannot read the assignments (network or session error) it says so with a
  **Retry** and shows no switches, rather than showing every credential as off.
  There is no separate "delivered the old way" state: switching on delivers the credential
  the current way and, on success, removes the files and the TOOLS.md row an earlier
  release wrote for that provider on that agent. Nothing is moved automatically on update.
  A `Protected` mode (secret kept out of the agent) is reserved and shown disabled,
  "coming later".
- **Requirements.** OpenClaw 2026.9.0 or newer for delivery; an older agent is refused with a message and no new enabled assignment. Trello and MongoDB need **2026.9.9** or newer: Trello's bundled skill runs through `jq`, which entered the image with that release, and 2026.9.9 is the only release MongoDB was verified on, so on an older agent the switch is refused and says to update the agent.
  The assignments are re-applied whenever Rev4a creates, recreates, updates, edits, restores, rolls back, starts or restarts the
  agent; a failure is logged and kept as the assignment's error, and never blocks the
  operation. Editing a credential's secret re-delivers it to the agents it is on, two agents at a time (the request is allowed up to 300 s). A
  credential switched on anywhere cannot be deleted until it is switched off. A failed delivery changes the card's status without changing its last successful delivery time; a credential never delivered shows "Never delivered".
- **Failures and leftovers.** A switch-off tries every supported step; if one fails the row says "Removal failed — the token may still be on this agent" with **Retry removal**, the removal is retried when Rev4a re-applies the agent's config, and the credential cannot be deleted meanwhile. This includes a failed removal of a credential found in the agent with no prior Rev4a assignment. Rows for an agent that is stopped or busy show its display name (the container name as a small label) and a disabled switch with the reason ("Not running — start the agent to change its credentials" / "Busy: <reason> — try again when it finishes"); the server refuses a container write with 409, while an intent-only **Remove** can clear Rev4a's setting without touching a stopped or busy container. Re-apply runs in the background after create, recreate, update, edit, restore, rollback, start and restart once the Gateway is ready. The switch of a running agent is disabled while a job owns it. Rows for a deleted agent (**Forget**) stay listed; deleting an agent drops its rows. A row replaced by another profile of the same provider reads "replaced by <label>".
- **Release note / rollback.** Writes to one agent's `openclaw.json` (credentials, subscriptions, the Rev4a provider block, the Control UI policy, channels, model changes) are queued per agent, so two of them never run at once: they only wait for each other when several happen together. Before rolling Rev4a back below this version, switch credentials off (or they stay in the agents): the older version knows neither the secret store nor the managed GitHub identity, and a replaced profile is never removed.
- **Codex runtime.** An agent on the ChatGPT subscription runtime gets the note "the token
  reaches only commands run through OpenClaw": environment entries do not reach the Codex
  native shell.
- **Agent panel.** The CREDENTIALS section lists, read-only, what is switched on for the agent.
- **Where the token lives.** In the agent's `~/.openclaw/state/openclaw.sqlite` (unencrypted,
  on the agent volume, so it survives a recreate and is part of a cold backup), for Trello also
  as plaintext in `openclaw.json`, for Vercel in `~/.local/share/com.vercel.cli/auth.json`, and
  for GitHub inside OpenClaw's private `gh` profile under `~/.openclaw/credentials/github/`.
- **The container is the source of truth.** The switches show what each agent really holds, read by
  live detection from every delivery method (the OpenClaw secret store, the managed GitHub identity,
  the Vercel CLI files and the files an earlier release wrote) and matched to the stored credentials by
  SHA-256 hash of the token. Rev4a's own table of switched-on credentials is only its intent, used to
  re-apply after create, recreate, update, edit, restore, rollback, start and restart. Mismatches are shown plainly:
  switched on but "Not found in the agent" (with **Redeliver**), found in the agent though not switched
  on from this Rev4a (the switch shows on; switching off removes it), or the agent holds another
  credential of the same provider (it says which one). While detection has not answered, the rows show
  a loading state, not "off". When the agent's credentials cannot be read (secret store locked, script cut short) the
  row says "Could not read the agent's credentials — showing Rev4a's setting" instead of claiming "Not found". After a start or restart Rev4a waits up to 10 minutes for the Gateway
  before re-applying; if it never gets ready the page shows "Gateway not ready — credentials not re-applied".

### Subscriptions (`/subscriptions`)
Use a ChatGPT Plus or Pro (Codex) subscription in an agent. One accordion, "ChatGPT (Codex)": closed it says "N of M agents connected" and the account email(s) with the plan ("Plus", "Pro"); open it lists the models the account offers (name, context) and one row per agent with its state (Connected until a date, Not connected, Stopped, Error), **Connect** / **Disconnect**. A connected agent also shows its model read-only ("Model: gpt-5.6-sol · fallback deepseek-flash") and a link "Change in the agent panel" (`/agents?agent=<id>`). The page manages accounts only; it never chooses a model.

- **Connect** opens a dialog: "Waiting for the agent…", then a link to OpenAI and a code to enter there with the ChatGPT account (expires in 15 minutes, with a countdown; Copy button). The code is 4 characters, a dash and 5 characters (for example `LBVC-84CXA`). The dialog polls the login every 2 s and ends in "Connected as <email>" or the error with Retry; reopening it (or a second tab) on an agent whose login is running resumes it, and if the dashboard restarted meanwhile it says "The login was interrupted. Start again." with a **Start again** button. The login starts only when the agent's Gateway is ready, and an agent that is being updated, recreated, edited, restored or backed up refuses it (409). While a login is starting or waiting, the agent itself is busy for up to the 15-minute code lifetime: stop, start, restart, recreate, update, edit, model save and token rotation answer 409 or skip the agent until the login ends or is cancelled.
- The page is asynchronous: the agent rows (with their display names) appear at once and each loads its own status, the models load apart, and every row can act while the others load. **Disconnect** runs in the background (the row shows "Disconnecting…" while the rest of the page stays usable).
- **The model is chosen in one place**, the MODEL section of the agent panel, where the primary picker and each fallback picker offer two groups: "Rev4a proxy" and "ChatGPT subscription" (the second only when the agent is connected; "Loading subscription models…" shows until they arrive). Any combination is allowed. Picking a subscription model as primary while no fallback is set pre-fills the previous primary as the first fallback ("Used when the ChatGPT subscription reaches its usage limit"), which you can remove, so the agent falls back to the Rev4a proxy by itself. **Disconnect** first puts the agent back on its own model, then signs the account out, then stops the agent's Codex runtime (the app-server OpenClaw runs the ChatGPT models through, which would otherwise keep running after the sign-out). No restart: the agent stays up, and connecting again starts a new runtime on the first subscription turn.
- Choosing a Rev4a model as primary in the agent panel is an explicit choice and **replaces** a subscription primary; the agent stays connected and the subscription model can be chosen again in the agent panel.
- The usage limit is the account's: it is shared with the owner's own use of Codex. Subscription calls are not counted as spend anywhere (Home, the Costs page totals, the agent panel, the system-health high-spend check): the Costs page shows them in their own *ChatGPT subscription* section with their API value, the saving the plan gives. Rev4a never gives an agent an OpenAI API key, so every `openai` call is treated as a subscription call; an operator who adds their own OpenAI key by hand would see those calls there too.
- **Usage limits.** At the top of the accordion, one block per connected account: "<email> · <Plan>" and a meter for the 5-hour and the weekly window, each with "N% used · resets at HH:MM" (today) or "resets Thu 15 Oct, 09:45" (later), in your local time. The meter turns to a warning at 80 % and to danger at 100 %, where a line says the connected agents use their fallback model until the reset. It loads after the rows (the first read takes 11 to 50 s on a slow host and holds about 360 MB in the agent, so the result, and a failed read too, is cached 3 minutes per account on the server). The block refreshes by itself every 60 s while the page is visible and when the tab gets focus, which only re-reads that cache; "Updated N min ago" shows the age, and only **Refresh** (one per account, each with its own loading state) bypasses the cache. A failed read shows an error with Retry. Connect and disconnect do not drop the usage cache (the quota belongs to the account, which they do not change); they do drop the model lists and the account-to-agent lookup (60 s).
- The agent panel's MODEL section has, under the pickers, a read-only line: "ChatGPT Plus · 5h 86% left · week 98% left" (or "Subscription: ChatGPT Plus, connected" while the usage loads or when it cannot be read; at 100 % of either window "Limit reached until <reset>: using <fallback model>") or "Subscription: not connected — connect it on Subscriptions" (linking here). An `openai/` primary on a connected agent is healthy (it is not in the Rev4a catalogue on purpose); on an agent that is not connected the panel warns.
- **Rollback.** Disconnect **every** agent here before rolling Rev4a back to 1.14.0. On 1.14.0 a subscription model may look like the Rev4a proxy model of the same name (`gpt-5.6-sol`, `-terra` and `-luna` are also catalogue models), with no warning, and any save there turns it into the paid proxy model; 1.14.0 also cannot disconnect. An `openai:` API-key profile an operator added by hand is not a ChatGPT sign-in: it is left alone and does not count as connected.
- On the agent list a subscription model reads "gpt-5.6-sol · ChatGPT" (proxy models keep their plain name, and some share it, such as `gpt-5.6-sol`), with no chip of its own; with **no** fallback it shows the "NO FALLBACK" warning, because the agent goes silent at the usage limit. Whether the agent is connected is in its panel.
- **Disconnect** asks for confirmation ("Disconnect <agent>? It goes back to <own model> and signs out of ChatGPT. Connecting again needs a new code."). It also reverts a subscription model held by the agent's `main` entry in `agents.list`, signs out under a 60 s limit inside the agent, and then checks that no ChatGPT profile remains ("The sign-out did not complete. Try again.").
- **Connect** is refused with 409 on an agent that is not on a supported OpenClaw version ("This agent is not on a supported OpenClaw version (2026.9.x). Update it first.") and with 503 when its status cannot be read ("Could not read this agent's subscription status: <reason>"; there is no slower fallback read). The agent is busy for a login for at most 60 s of readiness wait + 900 s of code lifetime + 60 s of tail; a login job older than that (1020 s) counts as expired, so a paused container cannot keep the agent busy forever. A second Connect over a login that just connected returns that login.
- Stopped agents are listed as "Stopped, status unknown"; an agent that is not on a supported OpenClaw version, or whose status cannot be read, shows the reason as its error, a disabled Connect and a **Retry** button that reads that agent again ("Retrying…"). A failed read has already been retried by the server (up to twice); an agent just created or recreated whose Gateway has not yet created its state database shows "the agent is still starting" rather than the unsupported-version refusal.

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
- **Control UI link** — the **Open** buttons go through `GET /api/agents/[id]/open-control-ui`, which redirects to the agent's published port on the host the dashboard was reached on: a one-time link on OpenClaw 9.x, the plain `#token=` link otherwise, with the token read inside the container. While the agent's Gateway is still starting the card shows a `STARTING m:ss` chip and **Open** reads *Starting…* and is disabled (`GET /api/agents/gateway`); after 10 minutes without readiness the chip reads NOT READY and Open is enabled again. Only *Starting* disables Open; a failed or missing readiness check never does.
- **Agent creation wizard** — multi-step form at `/agents/create`.
- **Channel Manager** — each agent detail panel has a Channels section with Telegram configuration and pairing management. Pending requests (a sender's `/start` creates one) show an **Approve** button; approved senders show **Revoke** with a confirmation. Approved senders are OpenClaw's pairing store, not the agent config: on 2026.9.x the SQLite store, read and revoked through OpenClaw's own store functions (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Browser access** — the detail panel section right after Channels. From OpenClaw 9.x each new browser must be approved once before the Control UI connects: the section lists requests waiting for approval (Approve / Reject) and approved browsers (Rename / Revoke), and the agent card shows a "browser waiting" badge. The **Open** buttons first ask the agent for a one-time link that pairs the browser with no approval, and open the plain token link when none can be issued (the agent is stopped, or the link fails). **Invite link** gives a link to send to someone else: their browser passes gateway auth and waits in the approval list until approved. The link carries the gateway token every agent shares; changing the agents token invalidates every link sent. All of it runs the OpenClaw CLI inside the container asynchronously.

### Memory limit per agent

**The picker.** The wizard, the agent panel's Edit form and the Configuration page all use one component, `MemoryLimitPicker`: *No limit*, 1.5, 2, 3, 4, 6, 8, 12 or 16 GB (1 GB = 1024 MB; sizes above Docker's total memory are not offered when it is known), or *Custom…*, any size in GB (for example `2.5` or `2,5`, rounded to whole MB; from 0.25 to 1024 GB) shown with its exact value in MB (`= 2560 MB`). Custom is not capped by Docker's total memory: only the presets are hidden. Opened on an existing limit it selects the matching size, or Custom with that limit in GB. The API still takes MB (minimum 256 MB). Below 2 GB a warning appears (it does not block): *OpenClaw needs about 1 GB just to start, and more while it works. Below 2 GB the agent may be killed while it starts or during a task.* This is measured, not a guess: an agent created with a 1000 MB limit was killed by the kernel while it was starting, and an idle OpenClaw 2026.9.3 sits at about 710-750 MB. When a limit is exceeded, Docker kills the process that uses the most memory (a memory hog inside the container was killed alone and the agent stayed up), and the agent restarts if it was the main process.

A memory limit is **always the operator's choice**: no agent gets one by itself, an update touches no existing agent, and the default is none. A Docker memory limit kills, it does not slow down: a process over the limit is killed by the kernel (and the agent restarts if it was the main one), so leave it empty for heavy workloads (headless browsers, builds) unless you know the figure.

- **Agent panel, RESOURCES** has a *Memory limit* row: `none`, or the usage against the limit ("896 MB of 2 GB", in the warning colour from 90 %). **Edit** opens the shared *memory limit picker* (below). Saving applies the limit **live** (`docker update`, no restart); swap is always set equal to the limit, so the limit is the total the agent can use. A value below the current usage asks for confirmation first, because it kills processes at once. **Remove limit** rebuilds the container (the agent restarts, no backup, the data volume is kept) because Docker cannot lift a limit on a running container; the usual edit banner follows it.
- A rebuild (update, rollback, recreate, edit) **carries the limit over**, including one set by hand with the docker CLI; the previous Rev4a silently dropped such a limit at the next rebuild. A restore never rebuilds the container (it only stops and starts it), so the limit simply stays.
- **Upgrade and rollback note.** Going back to an older Rev4a is safe for the data, but an agent that has a limit and is rebuilt by the older version (update, recreate or edit) **loses its limit**, because the older rebuild does not carry it. Set it again after upgrading.
- When the kernel kills a process for lack of memory (with or without a limit), the daemon records a `container_oom` alert (Recent alerts on the System page, in red; at most one per container per 10 minutes, with the number of kills in between) and RESOURCES shows "Out of memory <time>: a process was killed" for 24 hours.
- The System page shows a warning only when the running containers' memory is at 85 % or more of Docker's total memory **and** at least one running agent has no limit or its limit could not be read, with links to those agents. The picker keeps the preset of the agent's current value visible even when it is above Docker's total.

### Agent Creation Wizard (`/agents/create`)

**Step 1 — Template:** Select an agent template from `agent-templates/`. Each template is a directory with AGENTS.md, SOUL.md, MEMORY.md, and optionally BOOTSTRAP.md files.

Available templates:
- **Atlas** — general-purpose development agent
- **Argus** — security and audit agent
- **Prometheus** — client-facing project delivery agent
- **Custom** — blank slate. On first run, the agent runs a bootstrap ritual: introduces itself, learns who the user is, and together they define name, personality, tone, and boundaries. The agent writes SOUL.md, IDENTITY.md, and USER.md, then deletes BOOTSTRAP.md. No preset identity, fully user-defined.

**Step 2 — Config:** Enter agent name, optional port, an optional **Memory limit** picker (*No limit* is the default; it opens on the Configuration page's *Default memory limit for new agents* when one is set; the chosen size is sent in MB as `memoryLimitMb`), select a primary model from the available providers (pre-filtered by configured provider keys). The first model is pre-selected.

**Step 3 — Deploy:** `POST /api/agents/create` creates the Docker container and returns its port and the shared gateway token; the wizard links to `http://<host>:<port>#token=<token>`.

**Post-creation pipeline:**
1. The container boots with the newest supported OpenClaw version downloaded here, `openclaw-agent-base:<version>`; the create answers `409` when none is — see [Agent Templates](#agent-templates) below.
2. OpenClaw gateway starts automatically with `--allow-unconfigured`, generating its own default config.
3. The route waits for the gateway to finish starting with `waitForGatewayReady()`, up
   to 120 s: `/startupz` has to report `started`. A 503 (starting or draining), a
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

- **Software → image.** OpenClaw, `gh`, `jq`, `vercel`, `supabase`, Node — all
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
| **Rollback** | after an update: stop → restore the pre-update backup → recreate on the previous version. Everything since the backup is lost, including a recreate or restore done after a failed update: the panel names that job and its date next to the failure and in the confirmation. This is the only way back: 2026.9.9 moves the OpenClaw state database from schema 16 to 19 and 2026.9.3 refuses to start on that volume (verified), so recreating on the older version without restoring the backup does not work |
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
- `gh`, `jq`, `vercel`, `supabase`
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
- **System packages (panel and alert)**: the agent panel has a SYSTEM PACKAGES section after RESOURCES: the list `rev4a-apt` recorded (name, version) and the last restore (a pill: *Restored*, *Nothing to restore*, *Restoring…*, *Partly restored* or *Failed*; how long ago; the packages reinstalled; those that came back at another version; each failed package with its error). It polls every 10 s while a restore runs, every 60 s otherwise. An agent whose image predates the recorder shows "This agent's image does not record system packages. Update the agent to get it."; a stopped one "Start the agent to see its system packages."; a paused or restarting one says so; a failed read says "Could not read the agent's packages" (never "not supported"). A `running` status older than 20 min is shown as "The last restore did not finish", and a failed entry named `*` (the restore script reporting that the run itself timed out) as "The restore did not finish: <error>", not as a package Read-only. The daemon also reads the status of every running agent 60 s after start and every 10 min, and records one `packages_failed` alert (Recent alerts on the System page, in red) per failed or partial restore run; a status older than 24 h before the daemon's start is not alerted. Recreate, update and restore jobs do not wait for the restore.
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
3. Check API directly: `curl -H "authorization: Bearer <token>" 'http://127.0.0.1:3740/api/workspace?action=list'`

### API returns 500
- `docker exec` may fail on certain directories; the error text says why. 502 means the agent is stopped, 503 that Docker is down

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

# List Atlas container files
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?workspace=container-openclaw-atlas'

# Read a file
curl -b /tmp/cookies.txt 'http://localhost:3740/api/workspace?workspace=container-openclaw-atlas&path=/root/.openclaw/workspace/SOUL.md'

# Write a file
curl -b /tmp/cookies.txt -X PUT http://localhost:3740/api/workspace \
  -H 'Content-Type: application/json' \
  -d '{"workspace":"container-openclaw-atlas","path":"/root/.openclaw/workspace/test.md","content":"hello"}'
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
