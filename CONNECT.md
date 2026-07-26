# CONNECT.md — Getting Started with Olympus

> A monitoring dashboard for AI agent systems — tracks sessions, costs, agent hierarchy, workspace files, and event streams.

## One-Command Install

> **Note:** The repository is currently private. The one-command installer works
> only when the repo is public or when you have authenticated GitHub access.
> As an alternative, clone the repo manually and run `sudo bash scripts/setup.sh`.

```bash
curl -fsSL https://raw.githubusercontent.com/Flame0510/olympus/main/scripts/setup.sh | bash
```

This single command:
- Installs Docker + Node.js (if missing)
- Deploys Traefik reverse proxy
- Clones, builds, and starts Olympus
- Creates systemd services that auto-start on boot
- Prints your credentials and dashboard URL

**That's it.** Open the URL in your browser and follow the setup wizard.

## Prerequisites

| Dependency | Minimum | Notes |
|---|---|---|
| Linux | Ubuntu 20.04+ / Debian 11+ | The setup script targets these |
| Docker | 24+ | Required for creating agent containers |
| RAM | 2 GB | 4 GB recommended |
| Disk | 5 GB free | 10 GB recommended for agents |

**For the one-command install:** everything else (Node.js, Docker, dependencies) is installed automatically.
**For manual install:** you need Node.js 22+, npm, and Docker pre-installed.

## Quick Start (Manual)

```bash
git clone https://github.com/Flame0510/olympus
cd olympus
npm install

# That's it. One command starts everything:
olympus serve
```

Olympus auto-builds on first run and generates `.env` with credentials.
Open `http://localhost:3740` in your browser and follow the setup wizard.

```bash
# Custom port:
olympus serve --port 8080

# Or via env:
PORT=8080 olympus serve
```

`olympus serve` starts all three internal processes (Next.js dashboard, session daemon, terminal WebSocket) as a single foreground process group. Ctrl+C cleanly stops everything.

## Production (systemd)

For production deployments on bare-metal Linux, the setup script creates three
systemd services managed by a target. This is optional — `olympus serve` works
everywhere.

```bash
# One-command production install:
sudo bash scripts/setup.sh

# Or manage manually:
sudo systemctl start olympus.target
sudo systemctl enable olympus.target   # auto-start on boot
sudo systemctl status olympus.target
sudo journalctl -u olympus-next -f     # logs
```

Services:
- `olympus-next.service` — Next.js dashboard on port 3740
- `olympus-daemon.service` — Session poller + metrics collector
- `olympus-terminal-ws.service` — WebSocket PTY server on port 3741
- `olympus.target` — Master target that starts/stops all three

## Configuration

Olympus reads environment variables from `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3740` | Dashboard HTTP port |
| `OLYMPUS_DB` | `./data/events.db` | SQLite database path |
| `OLYMPUS_TOKEN` | — | Auth token for API access (required) |
| `OLYMPUS_PASSWORD` | — | Password for dashboard login |
| `OLYMPUS_JWT_SECRET` | — | JWT signing secret (auto-generated) |

Set them inline or via `.env`:

```bash
PORT=3740 OLYMPUS_PASSWORD=mysecret npm start
```

## Running for Development

```bash
npm run dev          # Next.js dev server on port 3720
```

## Backup & Restore

```bash
# Create a backup (DBs, configs, credentials)
sudo bash scripts/backup.sh

# Restore from a backup archive
sudo bash scripts/restore.sh backups/olympus-backup-20260724-120000.tar.gz
```

Backups include: `data/*.db`, `data/provider-keys.json`, `data/agents-token.json`, `models.config.json`, `.env`.

## Architecture

Olympus runs three processes under the hood:

1. **Next.js app** — serves the dashboard UI and API routes (port 3740)
2. **Daemon** (`daemon.js`) — polls sessions every 30s, writes to SQLite, collects system metrics
3. **Terminal WebSocket** (`terminal-ws-server.js`) — provides PTY terminal access to containers (port 3741)

`olympus serve` manages all three as a single process group. On Ctrl+C or SIGTERM, all children are cleanly stopped. The daemon calls `openclaw sessions --json --all-agents` when an OpenClaw instance is available. Without OpenClaw, the dashboard still works (you'll see an empty state).

## Using the Lineage Utility

To record agent hierarchy:

```bash
node lineage.js "<child_session_key>" "<parent_session_key>" "<Agent Name>"
```

## Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| Port in use | Another process on PORT | Change `PORT` env var |
| Blank dashboard | Daemon stopped | Restart `olympus serve` |
| Auth 401 | Wrong token | Check `OLYMPUS_TOKEN` |
| SQLite error | Missing system dep | `apt-get install sqlite3` on Linux |
| `better-sqlite3` build fail | Native binding mismatch | `npm rebuild better-sqlite3` |
| Certificates not issued | Wrong ACME email | Set `TRAEFIK_ACME_EMAIL` env var, re-run setup |
