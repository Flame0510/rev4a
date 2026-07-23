# CONNECT.md — Getting Started with Olympus

> A monitoring dashboard for AI agent systems — tracks sessions, costs, agent hierarchy, workspace files, and event streams.

## Prerequisites

- Node.js 22+
- npm
- SQLite3 (runtime dependency, auto-installed via npm)
- An OpenClaw instance (optional — Olympus works standalone for testing)

## Quick Start

```bash
git clone https://github.com/Flame0510/olympus
cd olympus
npm install
npm run build
npm start
```

This runs both the Next.js dashboard (default port 3740) and the daemon (session poller).

## Configuration

Olympus reads environment variables for configuration. Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3740` | Dashboard HTTP port |
| `OLYMPUS_DB` | `./data/events.db` | SQLite database path |
| `OLYMPUS_TOKEN` | — | Auth token for API access (required) |
| `OLYMPUS_PASSWORD` | — | Password for dashboard login |

Set them inline or via `.env`:

```bash
PORT=3740 OLYMPUS_PASSWORD=mysecret npm start
```

## Running for Development

```bash
npm run dev          # Next.js dev server on port 3740
```

## Running in Production

Use PM2, systemd, or your preferred process manager. Example systemd unit:

```ini
[Unit]
Description=Olympus Dashboard
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/olympus
ExecStart=/usr/bin/npm start
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=OLYMPUS_TOKEN=your-secure-token

[Install]
WantedBy=multi-user.target
```

## Verifying

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:3740
# Should return 200
```

Open `http://localhost:3740` in your browser.

## Architecture

Olympus has two processes:

1. **Next.js app** — serves the dashboard UI and API routes
2. **Daemon** (`daemon.js`) — polls sessions every 30s and writes to SQLite

Both are started together by `npm start`. The daemon calls `openclaw sessions --json --all-agents` when an OpenClaw instance is available. Without OpenClaw, the dashboard still works (you'll see an empty state).

## Using the Lineage Utility

To record agent hierarchy:

```bash
node lineage.js "<child_session_key>" "<parent_session_key>" "<Agent Name>"
```

## Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| Port in use | Another process on PORT | Change `PORT` env var |
| Blank dashboard | Daemon stopped | Restart both processes |
| Auth 401 | Wrong token | Check `OLYMPUS_TOKEN` |
| SQLite error | Missing system dep | `apt-get install sqlite3` on Linux |
| `better-sqlite3` build fail | Native binding mismatch | `npm rebuild better-sqlite3` |
