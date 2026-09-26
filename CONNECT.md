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
| Linux | Ubuntu 20.04+ / Debian 11+ | What production runs on; macOS works for development |
| Docker | 24+ | Required for creating agent containers |
| RAM | 2 GB | 4 GB recommended |
| Disk | 5 GB free | 10 GB recommended for agents |

You need Node.js 22+ and npm installed first. Docker too, except on Linux run as root:
there `rev4a` installs it when it is missing (Docker's `get.docker.com` script).

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

`rev4a serve` starts all three internal processes (the dashboard — Next.js through `server.js` —, the session daemon, the terminal server) as a single foreground process group. Ctrl+C cleanly stops everything.

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

`rev4a serve` starts all three internal processes (the dashboard — Next.js through `server.js` —, the session daemon, the terminal server) as a single foreground process managed by systemd.

## Configuration

Rev4a reads environment variables from `.env`. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3740` | Dashboard HTTP port |
| `REV4A_DB` | `~/.config/rev4a/data/events.db` | SQLite database path (the data directory follows `REV4A_DATA_DIR`) |
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
# Archive Rev4a's data directory (.env, data/, shared/) into ~/rev4a-backups/
bash scripts/backup.sh

# Restore it (the current state is archived first; rev4a.service is stopped if running,
# any other running `rev4a serve` must be stopped first)
bash scripts/restore.sh ~/rev4a-backups/rev4a-backup-20260926-120000.tar.gz
```

Run them as the user Rev4a runs as (root on a typical server install). The archive holds
every secret in plain text: keep a copy off the machine. Agent volumes are not included —
the dashboard's cold backups cover them. Details: `docs/dev/DATABASE.md` § Backup.

## Architecture

Rev4a runs three processes under the hood:

1. **Dashboard** (`server.js`) — Next.js (UI and API routes) plus the terminal's WebSocket, on port 3740
2. **Daemon** (`daemon.js`) — polls sessions every 30s, writes to SQLite, collects system metrics
3. **Terminal WebSocket** (`terminal-ws-server.js`) — PTY terminal access to containers (127.0.0.1:3741, reached through the dashboard's own port — no reverse proxy needed)

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
