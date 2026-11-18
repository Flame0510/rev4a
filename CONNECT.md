# CONNECT.md — Getting Started with Rev4a

> **Last updated:** 2026-11-18

**1.29.0:** Choose guarded presets on the **Remote access** page of the dashboard (`/remote-access`, guide: [rev4a.app](https://rev4a.app/en/docs/remote-access)) or in the Access step of the first run; Save & Restart works under systemd and under `rev4a serve` (a direct `next dev` asks for a manual restart).

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

HTTPS through a reverse proxy is recommended. Plain HTTP by IP works with no extra setting: the
session cookie follows the scheme your browser uses. On plain HTTP, the **Open** buttons on agents warn
first, because the agent's port receives your Rev4a session too; use an SSH tunnel or HTTPS.
Use one address consistently: after an HTTPS login or silent cookie upgrade, the Secure cookie prevents a later plain-HTTP login on the same host (even on port 3740) until it expires, up to 7 days; log out over HTTPS to clear it.

### Behind a reverse proxy or Tailscale

By default the panel (3740) and every agent's ports (3710-3779) listen on all interfaces, and Docker
bypasses `ufw`, so on a VPS they are reachable from the internet. To close them, add to
`/root/.config/rev4a/.env`:

```
REV4A_LISTEN=local
REV4A_AGENT_PORTS_LISTEN=local
REV4A_TRUSTED_PROXIES=127.0.0.1,::1
```

then `sudo systemctl restart rev4a` and Recreate each agent in the dashboard (Recreate, Update and Edit all
apply the agent setting; running agents keep their old ports until then). The panel keeps answering on 127.0.0.1, ::1 and the Docker gateway address (agents
reach their model there). A reverse proxy on the host targets `127.0.0.1:3740`; Traefik or nginx in
Docker target `host.docker.internal:3740` with `extra_hosts: host.docker.internal:host-gateway`; Tailscale:
`tailscale serve --bg 3740`. The agents' **Open** buttons then show the SSH tunnel steps when the
dashboard is not on the server itself. With `ufw` on and the proxy in a container, allow the Docker bridge to
reach 3740 (`ufw allow from 172.17.0.0/16 to any port 3740`). Rolling back to 1.27.x ignores `REV4A_LISTEN` and
opens 3740 on every interface again.
On Linux, hosts on the same network segment could route to the Docker bridge gateway even in local mode; firewall port 3740 on the public interface.

### Caddy Domain mode (1.30.0)

1. Point DNS for `rev4a.example.com` and `*.rev4a.example.com` at the Rev4a host. Allow public HTTP and HTTPS on ports 80 and 443.
2. On the Linux host, preview and apply root setup using the service's `REV4A_DATA_DIR`. Setup reads `PORT` from its `.env` and defaults to 3740. If the service is running on another port, pass it explicitly, for example `sudo PORT=8080 rev4a domain setup rev4a.example.com`.

   ```bash
   sudo rev4a domain setup rev4a.example.com --dry-run
   sudo rev4a domain setup rev4a.example.com
   ```

3. Restart Rev4a (`sudo systemctl restart rev4a` on a systemd install), then Recreate running agents so Docker republishes their ports on loopback.
   For a stopped agent with wide bindings, choose **Move and start** when you next start it.
4. Open the dashboard at `https://rev4a.example.com`. For an agent named Atlas, use `https://atlas.rev4a.example.com` for its Control UI and
   `https://atlas-3001.rev4a.example.com` for its published container port 3001. Control UI uses the existing OpenClaw token and device pairing.
   Sign in to dev ports as `rev4a` with the password in `<REV4A_DATA_DIR>/domain-auth.json`. This is a private file (0600).

Setup installs Caddy from its official apt repository if needed, backs up the main Caddyfile, comments out an existing dashboard site,
and adds the Rev4a import and the global certificate permission callback. Rev4a must be able to write the generated file and reload
the system Caddy instance. Caddy must be able to read the import. If you override the main file path, configure the service to use that file as well.
Routes are added for running, unpaused agents with active port bindings. The dashboard requests a sync after lifecycle
operations, and the daemon checks changes made outside the dashboard every five minutes. Rev4a reserves ports from
the managed file until the new Caddy configuration has loaded.
The local listen settings take effect after the restart and each agent rebuild. During the transition, original wildcard publishes still accept direct connections.

**Rollback or disable Domain mode:** Rolling back to 1.29.0 leaves Caddy serving the last imported file. To restore your earlier
configuration, remove the Rev4a import (or exclude its file from an existing import glob) and undo the Rev4a ask change and
dashboard adoption in the main Caddyfile, or restore the
timestamped backup if it contains all the settings you want to keep. Validate and reload the main Caddyfile, clear `REV4A_DOMAIN`
in its configured environment, and restart Rev4a. Review the two local listen settings before changing how you connect.
Agents keep their existing Docker bindings until rebuilt.

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
| `REV4A_LISTEN` | `all` | Where the panel listens: `all`, `local` or one IP (restart Rev4a) |
| `REV4A_AGENT_PORTS_LISTEN` | unset (keep current) | Where agents' ports listen: `all`, `local` or one IP (applies at create, Recreate, Update or Edit; unset keeps each agent's address, new agents use every interface; `all` moves agents back to every interface) |
| `REV4A_DOMAIN` | unset | Dashboard hostname for Caddy Domain mode |
| `REV4A_CADDY_FILE` | `/etc/caddy/rev4a.caddy` | Generated Caddy import |
| `REV4A_CADDY_MAIN` | `/etc/caddy/Caddyfile` | Main Caddyfile used for setup, validation and reload |

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
