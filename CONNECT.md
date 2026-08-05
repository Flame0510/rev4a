# CONNECT.md — Getting Started with Rev4a

> A monitoring dashboard for AI agent systems — tracks sessions, costs, agent hierarchy, workspace files, and event streams.

## Deploy on a VPS

```bash
git clone https://github.com/Flame0510/rev4a.git
cd 'rev4a'
npm install

# Start everything:
rev4a serve
```

For production (systemd auto-start on boot):

```bash
# Create systemd service file for rev4a.service
# See Production section below
sudo systemctl enable --now 'rev4a'
```

**That's it.** Open `http://your-vps:3740` in your browser and follow the setup wizard.

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
git clone https://github.com/Flame0510/'rev4a'
cd 'rev4a'
npm install

# That's it. One command starts everything:
rev4a serve
```

Rev4a auto-builds on first run and generates `.env` with credentials.
Open `http://localhost:3740` in your browser and follow the setup wizard.

```bash
# Custom port:
rev4a serve --port 8080

# Or via env:
PORT=8080 rev4a serve
```

`rev4a serve` starts all three internal processes (Next.js dashboard, session daemon, terminal WebSocket) as a single foreground process group. Ctrl+C cleanly stops everything.

## Production (systemd)

For production deployments on bare-metal Linux, create a single systemd service
that runs `rev4a serve`. This is optional — `rev4a serve` works everywhere.

```bash
# Manage manually:
sudo systemctl start 'rev4a'
sudo systemctl enable rev4a   # auto-start on boot
sudo systemctl status 'rev4a'
sudo journalctl -u rev4a -f   # logs
```

`rev4a serve` starts all three internal processes (Next.js dashboard, session daemon, terminal WebSocket) as a single foreground process managed by systemd.

## Configuration

Rev4a reads environment variables from `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3740` | Dashboard HTTP port |
| `REV4A_DB` | `./data/events.db` | SQLite database path |
| `REV4A_TOKEN` | — | Auth token for API access (required) |
| `REV4A_PASSWORD` | — | Password for dashboard login |
| `REV4A_JWT_SECRET` | — | JWT signing secret (auto-generated) |

Set them inline or via `.env`:

```bash
PORT=3740 REV4A_PASSWORD=mysecret npm start
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
sudo bash scripts/restore.sh backups/rev4a-backup-20260724-120000.tar.gz
```

Backups include: `data/*.db`, `data/provider-keys.json`, `data/agents-token.json`, `models.config.json`, `.env`.

## Architecture

Rev4a runs three processes under the hood:

1. **Next.js app** — serves the dashboard UI and API routes (port 3740)
2. **Daemon** (`daemon.js`) — polls sessions every 30s, writes to SQLite, collects system metrics
3. **Terminal WebSocket** (`terminal-ws-server.js`) — provides PTY terminal access to containers (port 3741)

`rev4a serve` manages all three as a single process group. On Ctrl+C or SIGTERM, all children are cleanly stopped. The daemon calls `openclaw sessions --json --all-agents` when an OpenClaw instance is available. Without OpenClaw, the dashboard still works (you'll see an empty state).

## Using the Lineage Utility

To record agent hierarchy:

```bash
node lineage.js "<child_session_key>" "<parent_session_key>" "<Agent Name>"
```

## Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| Port in use | Another process on PORT | Change `PORT` env var |
| Blank dashboard | Daemon stopped | Restart `rev4a serve` |
| Auth 401 | Wrong token | Check `REV4A_TOKEN` |
| SQLite error | Missing system dep | `apt-get install sqlite3` on Linux |
| `better-sqlite3` build fail | Native binding mismatch | `npm rebuild better-sqlite3` |
| Certificates not issued | Wrong ACME email | Set `TRAEFIK_ACME_EMAIL` env var, re-run setup |
