# CONNECT.md — Getting Started with Rev4a

> A monitoring dashboard for AI agent systems — tracks sessions, costs, agent hierarchy, workspace files, and event streams.

## Deploy on a VPS

Follow this section top to bottom on a fresh Ubuntu VPS. This npm install path was
verified on Ubuntu 24.04.5 x86-64. Commands use `sudo` and work from a sudo-enabled
account or as root. Rev4a runs as root in this guide: `~/.config/rev4a` means
`/root/.config/rev4a`, including when you start it with `sudo`.

### Prerequisites

| Dependency | Minimum | Notes |
|---|---|---|
| Linux | Ubuntu 20.04+ / Debian 11+ | This guide was verified on Ubuntu 24.04.5 x86-64; macOS works for development |
| Node.js | 22 | Install first; Rev4a does not install Node.js |
| npm | 10+ | Comes with Node.js |
| Build tools | `make`, `g++`, `python3` | Native modules (`better-sqlite3`, `node-pty`) compile on Linux. Install `build-essential` on Debian/Ubuntu; Ubuntu 24.04 already includes `python3` |
| Docker | 24+ | Installed by `rev4a serve` if missing when run as root on Linux; required for agent containers |
| RAM | 2 GB | 4 GB recommended |
| Disk | 5 GB free | 10 GB recommended for agents |

### Install Node.js, build tools, and Rev4a

```bash
sudo apt-get update \
  && sudo apt-get install -y curl build-essential \
  && curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh \
  && sudo bash /tmp/nodesource_setup.sh \
  && sudo apt-get install -y nodejs \
  && sudo npm i -g @flame0510/project-aether
```

Each step runs only if the previous one succeeded: if the block stops, fix the error it
printed before going on.

`@flame0510/project-aether` is the current package name; it installs the `rev4a`
command. Installation compiles the native modules and builds the dashboard through
the postinstall hook. Wait for installation to finish before starting Rev4a.

### Start Rev4a

```bash
sudo rev4a serve
```

On first run, Rev4a creates `/root/.config/rev4a/.env` with secrets, installs Docker
if missing (using `get.docker.com`), creates the `rev4a-network` Docker network,
and pulls the agent image. Wait until it listens on port 3740 and prints:

```text
[SETUP] XXXX-XXXX-XXXX-XXXX — open the dashboard and enter this code
```

`rev4a serve` starts the dashboard, session daemon, and terminal server as a single
foreground process group. **Ctrl+C** cleanly stops all three. Keep this terminal
open while completing setup.

### Plain HTTP or HTTPS

HTTPS through a reverse proxy is recommended. For plain HTTP by IP, set
`REV4A_FORCE_INSECURE_COOKIE=1` in `~/.config/rev4a/.env` and restart; otherwise the
Secure session cookie causes login to loop after the wizard. For this root install,
press **Ctrl+C** in the terminal running Rev4a, then run:

```bash
printf '\nREV4A_FORCE_INSECURE_COOKIE=1\n' | sudo tee -a /root/.config/rev4a/.env
sudo rev4a serve
```

### Open the dashboard and complete setup

Open `http://<server>:3740` in your browser, replacing `<server>` with your VPS IP,
or use your HTTPS dashboard address. Enter the **Setup code** printed by the current
`rev4a serve`, choose your dashboard password, and complete the wizard. The code
changes on every restart until a password exists; use the latest code. Configured
installs do not require a setup code.

For a custom port, stop the foreground process with **Ctrl+C**, then use either:

```bash
# Custom port:
sudo rev4a serve --port 8080

# Or via env:
sudo env PORT=8080 rev4a serve
```

### Run it as a service (systemd)

After setup, press **Ctrl+C** to stop any `rev4a serve` started by hand before
enabling the service, so two instances do not compete for the same port.
Confirm the binary path:

```bash
command -v rev4a
```

With the NodeSource install above it is `/usr/bin/rev4a`. If yours differs, use the
path printed by that command in `ExecStart` below. Write the full unit:

```bash
sudo tee /etc/systemd/system/rev4a.service > /dev/null <<'EOF'
[Unit]
Description=Rev4a Dashboard
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/.config/rev4a
EnvironmentFile=/root/.config/rev4a/.env
ExecStart=/usr/bin/rev4a serve
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now rev4a
sudo systemctl status rev4a --no-pager
```

The service starts now and at boot. It runs all three internal processes under
`rev4a.service`. To follow logs (press **Ctrl+C** to leave the log viewer):

```bash
sudo journalctl -u rev4a -f
```

If setup has not been completed, find the current `[SETUP]` code in these logs.
After changing `/root/.config/rev4a/.env`, restart the service:

```bash
sudo systemctl restart rev4a
```

For a custom service port, change `ExecStart` to `/usr/bin/rev4a serve --port 8080`,
then run `sudo systemctl daemon-reload` and `sudo systemctl restart rev4a`.

## Configuration

Rev4a reads environment variables from `~/.config/rev4a/.env`
(`/root/.config/rev4a/.env` for the VPS guide above). Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3740` | Dashboard HTTP port |
| `REV4A_DB` | `~/.config/rev4a/data/events.db` | SQLite database path (the data directory follows `REV4A_DATA_DIR`) |
| `REV4A_TOKEN` | — | Auth token for API access (required) |
| `REV4A_PASSWORD` | — | Password for dashboard login |
| `REV4A_JWT_SECRET` | — | JWT signing secret (auto-generated) |
| `REV4A_FORCE_INSECURE_COOKIE` | — | Set to `1` for plain HTTP by IP; prefer HTTPS through a reverse proxy |

Set them inline or via `.env`:

```bash
sudo env PORT=3740 rev4a serve
```

## Running for Development

Contributors use the [git-clone development setup in README.md](./README.md#development).
From that checkout:

```bash
npm run dev          # Next.js dev server on port 3720
```

## Backup & Restore

The scripts ship with the global npm package. Run them as root for the VPS install:

```bash
# Archive Rev4a's data directory (.env, data/, shared/) into /root/rev4a-backups/
sudo bash "$(npm root -g)/@flame0510/project-aether/scripts/backup.sh"

# Restore it (the current state is archived first; rev4a.service is stopped if running,
# any other running `rev4a serve` must be stopped first)
# Replace the archive path with the backup you want to restore:
sudo bash "$(npm root -g)/@flame0510/project-aether/scripts/restore.sh" /root/rev4a-backups/rev4a-backup-20260926-120000.tar.gz
```

Run them as the user Rev4a runs as (root on a typical server install). The archive holds
every secret in plain text: keep a copy off the machine. Agent volumes are not included —
the dashboard's cold backups cover them. Details: `docs/dev/DATABASE.md` § Backup.

## Architecture

Rev4a runs three processes under the hood:

1. **Dashboard** (`server.js`) — Next.js (UI and API routes) plus the terminal's WebSocket, on port 3740
2. **Daemon** (`daemon.js`) — reads every running agent's sessions from its container (every 30 s while something runs, 60 s idle), writes to SQLite, collects system metrics
3. **Terminal WebSocket** (`terminal-ws-server.js`) — PTY terminal access to containers (127.0.0.1:3741, reached through the dashboard's own port — no reverse proxy needed)

`rev4a serve` manages all three as a single process group. On Ctrl+C or SIGTERM, all children are cleanly stopped. The daemon asks each running agent container for its sessions through the container's own Gateway; it does not read the host's `openclaw`. With no agent running, the dashboard still works (you'll see an empty state).

## Lineage

Rev4a reads each agent's sessions from its own container (OpenClaw's `sessions.list`), so sub-agent
links and cron runs appear on the Lineage page without any agent doing anything. There is nothing to
register by hand (the old `lineage.js` utility and `POST /api/lineage` are gone).

## Troubleshooting

| Problem | Likely cause | Solution |
|---|---|---|
| Port in use | Another process on PORT | Change `PORT` env var |
| Blank dashboard | Daemon stopped | Restart `rev4a serve` |
| Auth 401 | Wrong token | Check `REV4A_TOKEN` |
| `gyp ERR! stack Error: not found: make` / node-gyp build failure | Missing build tools for `better-sqlite3` or `node-pty` | Run `sudo apt-get install -y build-essential`, then retry `sudo npm i -g @flame0510/project-aether` |
| Login loops after the wizard on plain HTTP by IP | Secure session cookie | Set `REV4A_FORCE_INSECURE_COOKIE=1` in `/root/.config/rev4a/.env` and restart Rev4a; prefer HTTPS through a reverse proxy |
