# Rev4a — VPS Dashboard

> **Last updated:** 2026-11-27

A Next.js 16 dashboard for monitoring and managing the OpenClaw ecosystem.

**URL:** `http://<vps-ip>:3740` (or behind a reverse proxy of your choice)
**Port:** 3740
**Process manager:** `rev4a serve` (single command). Production: systemd service (`rev4a.service`).
**Repository:** `github.com/Flame0510/rev4a.git` (branch: `main`)

---

## Unreleased

- When the Gateway offers no models, PULSE explains its API key requirement and links to Gateway. Chat becomes available as soon as the catalogue offers a model.
- Connecting ChatGPT or Claude on Subscriptions automatically sets the first model for an agent with no primary or fallbacks. Closing the Claude dialog before it reports the connection skips this step (the agent stays in "No model"; Use Claude from its card finishes it); when the agent cannot be read right after the sign-in, the row says so with a link to the Model section.

## 1.32.1 — Public repository, token-free publishing

No change to the app. The source is now public at `github.com/Flame0510/rev4a`, with its history
cleaned of personal data (the earlier private repository is archived). Releases publish to npm through
npm Trusted Publishing and the agent image through the workflow's own token, so no publishing token is
stored anywhere. Installs update as usual.

## 1.32.0 — npm package renamed to `rev4a`, safer host startup

The package is published as `rev4a` (it was `@flame0510/project-aether`): install it with
`npm i -g rev4a`. The command, the data directory and the systemd unit do not change. An install of
the old package does not update itself to the new name: stop Rev4a, `npm uninstall -g` the old
package, then `npm i -g rev4a` and start it again (see the release notes).

- **Docker auto-install is more careful.** `rev4a serve` installs Docker only as root on Debian, Ubuntu or a derivative, and only when it finds no Docker binary, no Docker socket and no Podman. It says so in the log first. Set `REV4A_DOCKER_AUTO_INSTALL=0` in the process environment (for systemd, an `Environment=` line) to never install it.
- **Rev4a no longer stops other programs on its port.** `rev4a serve` and `rev4a restart` used to kill whatever listened on the dashboard port (`fuser -k`) on Linux. Now they stop only a Rev4a process they recorded themselves; if another program holds the port, `rev4a serve` says which and exits. A Rev4a left running by an older version is not recognised once: stop it through its own supervisor (systemd does this on `systemctl restart`). An invalid `--port` or `PORT` is refused instead of falling back to 3740.

## 1.31.0 — Next.js 16.4.6, host restore fixes

- **Next.js 16.4.6** (security: fixes one critical and four high advisories of 16.2.6). The image optimizer is off: `/_next/image` answers 404 (Rev4a never used it).
- Next.js 16.4 no longer forwards a route's own `Content-Length`: Workspace previews and downloads and provider proxy answers are sent chunked. Browsers and agents read them as before; a download no longer shows its total size in advance.
- `scripts/restore.sh` no longer hangs on macOS (bash 5.2 could block forever while checking the archive), and refuses an archive whose only `.env`-like file is, for example, `.env.backup`.
- Removed from the package: the unused `html2canvas` and `cron-parser` dependencies and the one-off maintainer scripts `scripts/check-providers.mjs` and `scripts/add-auth.cjs`.

## 1.30.3 — Gateway token rotation

On agents running OpenClaw 2026.10.x, credential switches, model sync, subscription changes and
Telegram pairing work again after rotating the Agents Gateway token. At startup, Rev4a retries
pending native credential removals and failed switch-ons that still show a token mismatch, once
the running agent's Gateway is ready and Rev4a can verify that no job owns the agent. A mismatch
switch-on is retried only when it is the sole enabled credential for its service. The existing
timeout repair still takes priority for a timed-out switch-on of the same service. If two
credentials of one service are switched on or a failure falls outside startup repair, open
**Credentials** and switch on the one to keep or select **Retry removal**. Stopped agents retry
when they next start.

## 1.30.1 — Agents token reaches stopped agents

**Agents → Gateway Token → Save & Sync** now updates every agent. Running agents restart with the new token as before; stopped agents get it on their volume and use it at their next start. Before, a stopped agent kept the old token, and because the token file on the volume wins over the container environment it kept it even after a Recreate. Busy or paused agents are listed and keep the old token until you save again. After the update, Rev4a also gives the saved token, at its first start, to every stopped agent left on an older one by the old Save & Sync (logged).

## 1.30.0 — Caddy Domain mode

On Linux, `sudo rev4a domain setup <domain>` configures a dashboard hostname and agent subdomains on the system Caddy instance.

**Create response.** `POST /api/agents/create` no longer returns the shared gateway token (`controlToken`). Nothing in Rev4a read it; a script that did should open the agent through `/api/agents/<id>/open-control-ui`.

**Approval on a subdomain.** Open's one-time link pairs a new browser with no approval (OpenClaw accepts it only when the Control UI connects with that bootstrap token). A browser that already keeps a gateway token for that agent's subdomain (from an earlier token or invite link) connects with it instead and is asked for approval once; approve it, or clear the site data for that subdomain. The invite link in Domain mode is `https://<agent>.<domain>/#token=…` and always needs approval, as before.

**Forwarded headers.** Every route to an agent removes `X-Forwarded-For`, `X-Forwarded-Proto` and `X-Forwarded-Host`: the OpenClaw gateway answers 403 `proxy_attribution_required` to any request carrying them unless `gateway.trustedProxies` is set inside the agent (seen live on 2026.10.10). The Control UI keeps its own token and device pairing; dev ports also drop the `Authorization` header Caddy checked.

Domain setup and Caddy sync require `flock` from util-linux. Avoid editing Rev4a's `.env` while `rev4a domain setup` runs.
When setup rolls back saved settings, it restores the keys that still hold the values it wrote. A failed reload restores
the generated import and the main Caddyfile before retrying the reload. On first setup, an empty managed file preserves
the import target during rollback. If the rollback reload is unconfirmed, setup keeps the Domain settings and prints manual
recovery instructions. Rev4a logs the failure and reserves the candidate's routes until it can confirm a reload.
Add `--dry-run` to preview the Caddyfile and environment changes. Setup backs up the main Caddyfile and preserves any adopted
dashboard site as comments. Restart Rev4a and Recreate running agents to use the local listen settings.
Setup reads `PORT` from the data directory's `.env`. If Rev4a runs on another port, pass it explicitly
as in `sudo PORT=8080 rev4a domain setup rev4a.example.com`.

The dashboard is at `https://<domain>`. A running agent named Atlas uses `https://atlas.<domain>` for Control UI
and `https://atlas-3001.<domain>` through `https://atlas-3009.<domain>` for its published dev ports.
Stopping or pausing the agent removes its routes on the next successful sync. Starting or resuming it restores the routes
under the same names. Newly assigned labels for agent names ending in `-3001` through `-3009` receive an `-agent` suffix before collision numbering.
The next sync corrects Control UI names previously assigned a dev-port suffix. The managed file keeps deleted labels reserved.
Recreate keeps a legacy agent's assigned hostname when its Docker container name changes. The first sync records its stable agent ID.
Delete waits up to 20 seconds for route sync. The managed Caddy file reserves its routed host ports.
Restore requests a sync as soon as the restored agent is ready.
Port allocation pauses if the managed file is unreadable or its directory lock cannot be acquired. The Create page shows the reason.
An Edit can reuse a routed host port for the same TCP container port. It refuses a shift to another container port while the old route exists.
OpenClaw token and pairing protect Control UI. Managed HTTPS dev-port names use HTTP Basic authentication as `rev4a`
with the password in `<REV4A_DATA_DIR>/domain-auth.json`. Direct host-port access follows `REV4A_AGENT_PORTS_LISTEN`.
With Domain mode's local setting, Recreate republishes the ports on loopback only.
Sync replaces an invalid or incorrectly protected credential and saves it before reloading Caddy.
The dashboard session cookie is host-only.

Each agent's HTTPS Control UI can be installed as a separate app with the agent's display name.
Open the Control UI and use your browser's install action. On iOS, **Add to Home Screen** may
suggest the page title **OpenClaw Control**. Rename it to the agent's name before adding it. A browser that opened the
agent before this feature may still show "OpenClaw": its Control UI service worker keeps the old manifest
until OpenClaw is updated on that agent. Uninstall the old app and clear the site data for that
subdomain, then install again.

On **Remote access**, the **Domain mode** wizard validates the dashboard hostname as you type and lists
the A and AAAA records for that name and its wildcard. Create one record per expected public server
address. If Rev4a finds no public addresses on the host, use the server's public IP.
**Check** refreshes Domain mode status and compares the expected records with answers from the server's
DNS resolver. Copy the dry run, then run the setup command on the server. Both commands include the port, even when it is 3740,
and any non-default data directory and Caddyfile paths. They use the running settings or the saved setup values when a change is pending.
Setup saves custom Caddyfile paths for the restart, installs Caddy if needed, and backs up
and adopts the Caddyfile when changes are needed. After setup and restart, open the dashboard URL
and select **Check** to confirm status and DNS.

With Domain mode on, **Remote access** shows the HTTPS dashboard link, Caddy installation, managed
file, import, on-demand TLS ask, count of agent routes in the managed file on disk, and whether a restart is
pending. DNS is checked automatically when you open the page with Domain mode active. If the Caddy
callback points to an old Rev4a port, run the setup command again. A generated file missing either
site is marked **Incomplete**. Current setup shows **Domain (Caddy, managed by Rev4a)** when the
managed file is ready. Under **Dev-port credential**, the username
is `rev4a`. Select **Show** to fetch the password, then **Copy** or **Hide**. The password is available
once Rev4a has saved the credential for a validated dev-port configuration.

With an active managed route, **Open** on the agent card or in the panel goes directly
to the agent's HTTPS subdomain through a one-time link, with a token link as fallback.
Rev4a checks the route against the agent's current Docker publish on every Open. While the address
is being updated, the tab asks you to try again in a moment and Rev4a requests a Caddy sync.
The **Ports** section lists published TCP ports 3000–3009, their host mapping and whether a process is listening.
It loads when the panel opens, when the agent's running state or port bindings change, and on **Refresh**.
It shows managed HTTPS links in Domain mode.
Each routed dev port prompts for HTTP Basic authentication as `rev4a`. See **Remote access** for the password.
A reachable publish outside Domain mode shows a direct link. Unreachable publishes on a running agent show an SSH tunnel command.
For an IPv6-only wildcard publish, the command forwards to `[::1]` on the server.
Dev servers must bind to `0.0.0.0` inside the container and accept the operator's domain in their Host checks.

The default model offered in **Create Agent** may change with the 1.30.0 model catalogue.

See [Domain mode setup](../CONNECT.md#caddy-domain-mode-1300) for DNS, setup and rollback steps.

## 1.29.0 — Remote access presets (NET-1a)

The dedicated **Remote access** page (`/remote-access`, Setup sidebar group next to Config) offers three choices:
**This computer only** (both listen keys `local`), **Direct (IP)** (both `all`), and
**Domain (your own proxy)** (both `local`, append missing `127.0.0.1` and `::1` to
`REV4A_TRUSTED_PROXIES`). Unset listen keys show **Default (as before)**; a mix that matches none is **Custom**. A confirmation lists
all keys and values in a compact PropertyList, with accent values and unchanged pills, then saves through Config's shared `lib/env-edit.ts` writer.
The current preset is labelled Current and disabled; Apply reads Already applied and is disabled when no values change. Preset icons are shared with the wizard; running agents use ItemList rows with keyed Recreating feedback.
No other environment lines or existing proxy entries are removed. The guide is
[Remote access](https://rev4a.app/en/docs/remote-access). Use this preset for nginx, Traefik, or Tailscale serve in front of Rev4a.
For managed Caddy setup, use the **Domain mode** section.

Only localhost, localhost., 127.0.0.1 and ::1 browser URLs can choose This computer only.
Other 127.x loopback URLs show the canonical `http://127.0.0.1:<port>` to open first.
In local mode the panel also listens on the Docker bridge address on Linux, where it is
reachable by containers on this host only.
Domain always requires the Switch acknowledgement confirming an already tested HTTPS proxy, including
on an HTTPS hostname. The modal names `127.0.0.1:<port>`, `[::1]:<port>` or the Docker host
bridge as its required target; forwarding to a LAN/public/Tailscale IP stops working.
These client-location guards prevent accidental lockout; they are UX guards, not authorization.
Direct is always available; the plain HTTP security warnings remain. A loopback browser
with the panel listening on all interfaces sees **Rev4a is also reachable from your network**
and a **Manage** link to the page. System keeps one compact mode/status row below the host charts; memory and storage remain at the top. Plain HTTP and LAN notices remain on System.

**Restart now** restarts all Rev4a services. The list then offers individual **Recreate**
buttons for running agents whose published addresses differ (including local → all).
Paused agents count as running for this purpose.
Each click takes the existing cold backup and polls its job. Its Recreating button stays visible
through backup stops and new port bindings until the job finishes. Pending trusted-proxy changes
survive a page reload by comparing saved settings with the current boot. Nothing recreates automatically.
If restart confirmation times out after 60 seconds, Retry becomes available while the previous boot identity
is retained. A later read from a new boot clears the obsolete timeout and enables Recreate.
Successful reads clear transient status errors without dismissing action failures, restoring System's LAN notice.
**Start with different ports (NET-1e, 1.29.0):** stopped agents whose bindings differ from the
Remote access setting ask before starting. **Start <agent>** offers **Move and start** (the existing
cold-backup Recreate job, followed until running), **Start as is** (retain the current bindings), and
Cancel, with a Remote access link. The panel's **Restart Container** asks too when stopped,
using the same dialog; `/restart` also enforces the choice for direct callers. Nothing recreates automatically.
If Move or Recreate fails, Rev4a tries to restart the original container only if it was running at
admission, the backup stopped it, and it still exists. If the rebuild already removed the original,
nothing is restarted. If the replacement has already started when a later step fails (for example,
the Gateway times out), it is left running and the job reports failure.
Cards and the detail panel show a warning **Ports: every interface** (or the current Control UI address)
with the title **Recreate to apply the Remote access setting**. The panel keeps its existing Recreate
confirmation next to the pill for running agents; stopped mismatches show only the pill and ask on Start.
Remote access says **N stopped agents will ask before starting**. An empty agent-port setting keeps
existing behavior without a prompt or pill; an explicit all also detects local bindings.
The comparison and rebuild skip dynamic bindings with an empty `HostPort`. Rev4a always
publishes explicit host ports.
Running Restart and Stop retain their behavior. Busy operations keep their existing refusal;
Start and Restart recheck after inspect, then check the persisted lifecycle claims in a short SQLite
transaction and run the Docker command right after it (outside the transaction, so other writers are
never blocked). A claim from another process landing in the few microseconds between the check and the
command is not excluded; before 1.29.0 Start had no such check at all. A recreate (or Move) cut off by a
Rev4a restart starts the old container again only if it was running when the job began
(`agent_recreates.was_running`).

**Upgrade safety (NET-1e):** one additive database column, `agent_recreates.was_running` (added at
startup with a guarded `ALTER TABLE … ADD COLUMN`, idempotent; NULL on older rows keeps the old
recovery behaviour). No config, environment, provider-key or volume migration.
The first read checks already-inspected bindings; no startup fleet rewrite or backup runs. Older
OpenClaw agents can still start as is, stop and open their Control UI; Move uses existing image and
backup checks. Existing stopped mismatches are covered immediately by the new prompt. Rev4a 1.28.x
can read the same data and recreate records. Before downgrading, wait for every in-progress Move
or Recreate to finish (`done` or `failed`), because 1.28.x recovery restarts the old container on
its old bindings.

Supervisor restart flags use `REV4A_DATA_DIR/data`, or `~/.config/rev4a/data` when unset, exactly like
the launcher on Linux, macOS and Windows. A systemctl timeout is logged as a failure and falls back to
the supervisor when available; a non-timeout shutdown signal alone does not request a second restart.

First run is **Welcome → Access → Providers → Agent → Ready** (four setup steps, then Ready).
Access is skippable. **Only this computer** defers both the preset write and restart to Finish,
so choosing another option or skipping cancels it without changing `.env`;
**From other devices** links to the domain/Tailscale guide and changes
nothing; **By IP for now (not secure)** changes nothing and explains the warnings. Completed
installs still land at Ready and never receive a new Access prompt. A local choice is
remembered per tab until Finish, including after a page reload. Finish uses authenticated
Config restart, so an inherited service password works; Setup keeps its `.env` password check.
When automatic restart is unavailable, Ready shows the manual-restart message and
Continue to Rev4a completes without repeatedly requesting a restart.

**Upgrade safety:** no schema, provider key, agent volume or default changes; no automatic
network edits or agent jobs on update. Startup only adds a runtime supervisor marker and
uses the existing idempotent repair to remove stale copies from plain `.env` files. Older
agents use the existing Recreate flow. Rollback to 1.28.0 understands every saved setting;
Config's restart on non-systemd installs returns to the old limitation after rollback.

## 1.28.0 pre-release fixes (FIX-128)

- Claude connections set `IS_SANDBOX=1` correctly in production builds; the existing daemon repair also fixes earlier connections.
- Port edits keep the Control UI's current listen address when `REV4A_AGENT_PORTS_LISTEN` is unset; explicit settings still win.
- Wildcard IP spellings are refused as explicit listen addresses, and wildcard Docker gateways are excluded from local listeners. Use `all` to request every interface.
- System's Remote access line distinguishes keeping each agent's address from publishing on every interface.

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

For settings loaded from `.env`, use `/config` (UI) or edit the file directly. Before `.env` loads, `rev4a serve` reads `REV4A_DATA_DIR`, `REV4A_DOCKER_WAIT_SECONDS`, and `REV4A_DOCKER_AUTO_INSTALL` from the process environment (a shell export or a systemd `Environment=` line). `npm install` reads `REV4A_SKIP_POSTINSTALL_BUILD`. See [.env.example](../.env.example) for file settings.

| Variable | Required | Description |
|---|---|---|
| `REV4A_PASSWORD` | Yes | Login password for the dashboard |
| `REV4A_TOKEN` | Yes | Token used for programmatic API access |
| `REV4A_JWT_SECRET` | Yes | Secret used to sign session JWT tokens |
| `REV4A_API_KEY` | No | Legacy master key, still accepted by the Gateway provider endpoint (auto-generated). Agents use tokens derived from the Gateway key instead |
| `GATEWAY_TOKEN` | No | Shared token handed to agent containers |
| `REV4A_DATA_DIR` | No | Root of all persistent data (default: `~/.config/rev4a`) |
| `REV4A_DB` | No | Path to the events database (default: `<data dir>/data/events.db`) |
| `REV4A_CREDENTIALS_DB` | No | Path to the credentials vault database |
| `REV4A_ROOT` | No | Installation root, used by `rev4a update` to detect a git checkout |
| `REV4A_DOMAIN` | No | Enables domain syncing for this dashboard DNS hostname. Unset leaves domain syncing inactive |
| `REV4A_CADDY_FILE` | No | Rev4a-generated Caddy import (default `/etc/caddy/rev4a.caddy`) |
| `REV4A_CADDY_MAIN` | No | Main Caddyfile passed to setup, validation and reload (default `/etc/caddy/Caddyfile`) |
| `REV4A_LISTEN` | No | Where the panel listens (1.28.0): `all` (default, every interface), `local` (127.0.0.1, ::1 and, on Linux, the Docker host-gateway address) or one IP of this host. Read at start-up: restart Rev4a. Editable on the Config page |
| `REV4A_AGENT_PORTS_LISTEN` | No | Where agents' published ports listen (1.28.0): `all`, `local` (127.0.0.1) or one IP; unset keeps each agent's current address (new agents use every interface). Read at each create, Recreate, Update and port edit, so a change needs only a Recreate. Left empty, a Recreate or port edit keeps the address each agent already has; write `all` to move agents back to every interface. A value that is not empty, `all`, `local` or an IP is refused by the Config page; an IP this host lacks is treated as `local`, and a Recreate whose existing binding is on a missing address is refused before the old container is removed. Remote access distinguishes keeping each agent's address from publishing on every interface and shows how many running agents are still on a different address. Editable on the Config page |
| `REV4A_TIMEZONE` | No | Default dashboard time zone (IANA name), used only while none is saved in *Config > Time zone*; a saved zone wins, and with neither the server's own zone is used |
| `REV4A_FORCE_INSECURE_COOKIE` | No | No longer read since 1.28.0: the cookie follows the scheme the browser uses. Leave it in `.env` if you may roll back to 1.27; without it, 1.27 on plain HTTP by IP loops at login |
| `REV4A_AGENT_IMAGE_REGISTRY` | No | Registry repository agent images are pulled from (default: `ghcr.io/flame0510/rev4a/openclaw-agent-base`); a `localhost` registry is reached over plain HTTP |
| `REV4A_DOCKER_WAIT_SECONDS` | No | How long `rev4a serve` waits for the Docker daemon at start-up (default `90`, capped at 600) |
| `REV4A_DOCKER_AUTO_INSTALL` | No | Set to `0`, `false`, or `no` (case-insensitive) in the process environment to skip Docker auto-install |
| `REV4A_LEGACY_BACKUP_VOLUME` | No | Name of the legacy Docker volume older releases kept agent backups in (default `rev4a-backups`). Set it only when a second Rev4a (a test instance) runs on the same Docker, so it never migrates the real volume; an invalid name disables the legacy side |
| `REV4A_DEV_ORIGINS` | No | Extra comma-separated hostnames or IPs allowed to reach `next dev`; no effect on a production build |
| `REV4A_SKIP_POSTINSTALL_BUILD` | No | `1` in CI: `npm ci` then skips the post-install `next build` (the workflows build as a separate step). An installation build failure exits non-zero; startup checks `.next/BUILD_ID` before serving. Any non-empty value skips the post-install build, `0` included — leave it unset to build |

See [Alerts](#alerts-telegram) below for the Telegram alert variables.

## Agent creation

Every agent is created with:

- A host port mapping (`-p <port>:3000`) for direct access
- Control UI at `http://<host>:<port>` in direct mode or the agent's managed HTTPS hostname in [Domain mode](#1300--caddy-domain-mode), opened from the Agents page through `GET /api/agents/[id]/open-control-ui`
- The provider gateway at `http://host.docker.internal:3740/api/provider/v1`
- `gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback: true`, so the Control UI opens on whatever host the agent is reached on, and pages from other origins are refused
- `--init`: Docker's tini runs as PID 1, with OpenClaw as its child, and collects orphaned processes the moment they exit. Without it `openclaw-gateway` is PID 1 and never collects them: every process a tool leaves behind (Chrome, builds, scripts) stays a zombie and counts against the container's pids limit (9 365 on the VPS) until the container cannot start anything. Measured before the fix: 1 542 zombies in one agent after four days of browsing and builds. tini forwards `docker stop`'s SIGTERM, so OpenClaw still shuts down cleanly. Set at create and in `recreateAgentContainer` (recreate, update, edit); an existing agent gets it the next time it is recreated.

The first automatically assigned host port block is 3700–3709 (or user-specified);
the gateway listens on port 3000 inside the container.

Domain and HTTPS routing (Traefik) is an external concern — operators can
configure it on top of the base setup if needed, but Rev4a does not couple
to any specific reverse proxy.

## Config persistence

When environment variables are saved via the Config page (Save & Restart):

1. The client sends only values changed since the last successful load or save.
   The data directory's `.env` (`~/.config/rev4a/.env`; the `.env` in the installation
   root is a link to it) is patched by physical line: replace the last assignment of
   an edited key and remove its earlier duplicates, append a new key, or remove all
   assignments of a stored non-empty value when cleared. Unchanged empty assignments stay intact.
   Other keys (including `GATEWAY_TOKEN`, `PORT` and operator-defined settings),
   comments, blank lines, order and line endings stay intact. An unchanged value
   retains its quoting, including when an older open tab sends the entire GET result.
   Rev4a edits `.env` automatically only when every line is blank, a comment or a one-line `KEY=value` (a quoted value closing on the same line). A file with a multi-line or unterminated quoted value, a value on the next line, text after a closing quote (including an inline comment such as `REV4A_TOKEN="t" # comment`), or a backslash immediately before a same-kind quote (including the closing quote) is ambiguous across tools: an edit from Config then answers `409` and writes nothing (edit the file by hand), and the startup repair of runtime keys is skipped with a log line. Unchanged values, including inherited multi-line ones, are never an edit. Unchanged stored values are
   compared before validation and left untouched. New values must be strings
   without CR, LF or NUL; invalid entries reject the entire
   request with `400` naming the key. Every `.env` assignment writer uses the shared
   `lib/env-file.js` validator, including `writeEnvVar()`.
   Only ENOENT (a missing file) permits an empty starting file; other read errors
   abort the write. Config returns `500` without changing the file. Submitted keys
   must have a `REV4A_` or `PROVIDER_` prefix and pass the assignment validator;
   legacy dotted keys remain valid. Runtime-only keys (`REV4A_SERVER_PID`,
   `REV4A_STARTED_AT`, `REV4A_RUNNING_VERSION`, `REV4A_TERMINAL_SECRET`,
   `REV4A_SETUP_CODE`) are omitted from GET and silently ignored on PUT. An allowed
   key absent from the file is shown from the process environment, but is written
   only if the submitted value differs from that inherited value.
   Clearing an inherited-only non-empty value returns `400` with
   "This value comes from the service environment, not .env; change it there."
   Config shows this error, keeps the edit and does not restart or save any part of the request.
2. After a file change, `sudo systemctl daemon-reload` is attempted; it is harmless
   where there is no systemd. A no-op save neither writes nor reloads.
3. **Save & Restart** uses `lib/rev4a-restart.ts`, shared with setup and System. After
   sending the answer, it restarts its own systemd unit or writes the supervisor's
   `.restart-flag`, reloading all services and `.env` on Linux, macOS and Windows.
   A direct `next dev` start returns 409, **Restart Rev4a by hand to apply**, without
   touching a restart flag or terminating a process.

**BUG-14 update note:** on startup, before Next.js builds or starts, `ensureEnv()`
removes assignments of the runtime-only keys left in `.env` by earlier Config
saves. The repair is idempotent and logs key names, never values. It preserves all
other lines and runs alongside the loader-key repair. Previously deleted operator
keys and comments cannot be reconstructed and are not restored. Databases, provider
key files and agent volumes are unchanged; older agents need no changes. The repair
runs only on a plain `.env` (one-line assignments; `isPlainEnvFile` in
`lib/env-file.js`) and is skipped, with a log line, otherwise. The loader-key repair
is line based on purpose: it comments matching lines even inside multiline quoted values
or after an unterminated quote. It recognizes CRLF, CR and LF, `KEY=value`, `KEY: value`
and `export` prefixes, retaining the original separators. The launcher also clears
runtime-only keys inherited from the shell or systemd's `EnvironmentFile` from
the base child environment before setting fresh per-boot credentials. The repair
creates no new configuration format, so previous releases
can read the resulting file on rollback (their Config save bug would return).

**BUG-15 update note:** hand-written `.env` values now use the same dotenv-style
reader in Config, the launcher, authentication fallbacks, password setup and
setup/restart. Unquoted `#` starts a comment; quotes protect literal `#`, outer
quotes are removed, double-quoted `\n`/`\r` are decoded, and the last assignment
wins even when empty. `export`, `KEY: value`, CRLF, CR and LF are accepted.
If your file says `REV4A_PASSWORD=abcdefgh # note`, after updating and restarting
the password is `abcdefgh`; do not type ` # note` when signing in. A session tied
to the previously interpreted password may require signing in again. Quote a
password containing a literal `#`. When `rev4a serve` builds the child environment,
non-empty file values override inherited service values. Empty file values mean
unset and preserve any non-empty inherited value, for every key. Authentication
uses that resulting environment before falling back to the file. Change inherited
values in the service environment.
The file is not rewritten by reading it. First-run password setup now replaces
empty `REV4A_JWT_SECRET` and `REV4A_TOKEN` assignments with generated secrets, keeping
non-empty ones. For installs that already completed setup with an empty secret,
`rev4a serve` fills explicit empty JWT/token assignments automatically at startup
when the file is plain and no non-empty service secret overrides them. It preserves
other settings, creates a sibling temporary file exclusively with mode `0600` and renames it over
the real target (preserving a symlinked `.env`), logs key names only, and makes no
further change on a second start. A partial or failed write leaves the original
file intact, removes only a temporary file created by that attempt, and is retried
on the next start. Failure to resolve the real path aborts the repair; a pre-existing
temporary path is left untouched and produces a warning rather than being followed
or overwritten.
An unusual/uneditable file produces a warning with manual repair guidance; a write
failure logs a warning and is retried on the next start. Existing non-empty secrets
are never rotated.
If the repair fills an empty JWT secret, everyone must log in again; existing
browser sessions cannot be verified with the new secret. Filling an empty API
token enables Bearer access with the generated token shown in Config.
Clearing a service-only value in Config now shows the error above.
Files written by Rev4a keep their existing meaning; `$` is still refused on write.
No database, provider key file or agent volume is changed, no stored-data scan
is added at startup, and older agents need no changes. Previous releases can read
the files on rollback, but their parsing inconsistencies and save defects return.

### First-run ownership (SEC-14)

Before a password exists, `/setup` asks for the setup code and a password of at least
8 characters. `rev4a serve` generates an 80-bit random code per start and prints it
with a `[SETUP]` hint in its terminal (or `journalctl -u rev4a` under systemd). It
passes the code only to `server.js`, never writes it to disk, and generates no code
for an already-configured install. Direct Next.js starts generate and log one code
on the first protected setup request instead. The password is stored so it reads back exactly: one containing `$`, or a single quote together with leading/trailing spaces, `#` or a leading quote, is refused with 400, and an existing `.env` with multi-line or ambiguous values makes setup answer 409.

All pre-setup API calls use `x-rev4a-setup-code`: password setup, agent-image reads
and downloads, setup restart, and wizard status/complete/reset. Case, dashes and
spaces do not matter. A missing/wrong code returns `403` with instructions to find
it; comparisons use the shared constant-time secret comparison. After a password
exists the code is ignored and normal cookie/bearer authentication applies; password
setup remains `409`. The final password write synchronously rechecks configuration
and uses a freshly read `.env`, so a request paused reading its body cannot replace
the owner's password. Setup and wizard clients retain the code only in per-tab
`sessionStorage` with guarded access; wizard completion clears it.

On upgrade (and at every start), the launcher comments out loader-control lines in
`.env` before anything runs Next: `NODE_OPTIONS`, `NODE_REPL_EXTERNAL_MODULE`,
`LD_PRELOAD`, `LD_LIBRARY_PATH` and all `DYLD_*` (the line stays, prefixed with
`# Disabled by Rev4a: …`). Next.js loads `.env` on its own for `next build` and for the
server, so skipping them in the launcher is not enough. It logs the key names once
(never the values) and also skips them when it reads `.env`; other operator keys are
still passed to children. After the line repair, the launcher asks Next.js's own `.env` loader (`@next/env`, in a separate process) which keys it would load from the package root: if a loader key is still there in a form the line repair cannot follow (for example the key and its `=` on different lines), Rev4a refuses to start and logs the key name with the file to fix (if that check itself cannot run, it logs a warning and starts, relying on the line repair and on `server.js` removing loader keys Next loaded). Values are written so that Next.js and Rev4a read them back exactly: a value with `#`, leading or trailing spaces or a leading quote is single-quoted; a value containing `$` is refused with 400 (Next.js expands `$VAR` in every `.env` value it loads, even single-quoted, and its server overwrites what the launcher passed, so a password with `$` would change after a restart; values already in `.env` are not touched), and so is one that cannot be represented (a single quote combined with leading/trailing spaces, `#` or a leading quote; a backslash at the end of a quoted value; a Unicode line separator). `server.js` snapshots inherited loader keys before
requiring Next, then removes newly added loader keys after `app.prepare()` so
Next's own `.env` loading cannot pass them to updater or other child processes.
Operator settings inherited from the shell or systemd are retained in both the
launcher and server (including Node memory limits). The launcher also ignores
any `REV4A_SETUP_CODE` entry in `.env`. No database, vault or agent-volume migration is
required; the `.env` repair above is idempotent. An operator who kept
`NODE_OPTIONS` in `.env` on purpose must move it to the service environment (release note). Older agents and rollback data compatibility are unchanged; rolling
back also restores the older setup and loader security behaviour.

## Components

- **Rev4a:** Next.js app serving the dashboard UI and REST API. Reads Docker state, container configs, and agent workspaces via `docker exec` and `fs` calls.
- **Traefik:** External reverse proxy (optional). Rev4a does not depend on it — operators can use any reverse proxy or none at all.
- **OpenClaw agents:** Docker containers with `AGENT_ID` label. Rev4a discovers them dynamically via `docker ps`.

---

## Pages

| Route | Description |
|---|---|
| `/` | System overview — health, sessions, the machine's CPU / RAM / disk (links to `/system`), what the agents spent today (the agents' own figures, without ChatGPT subscription calls; `/costs` can show more, see below), live feed |
| `/agents` | Running agents (Docker containers with `AGENT_ID`), gateway token management, agent creation wizard, channel manager (Telegram pairing). On a phone the page scrolls in one region (banners, the Gateway Token form, then the list); each agent is an `AgentCard` with the status switch, name, Open Control UI, image/ports, model and status chips (STARTING with the elapsed time while an agent's Gateway boots, NOT READY after 10 minutes); Open is disabled only while the Gateway itself answers 503 (a timeout or no answer shows STARTING but leaves Open enabled; after 10 minutes NOT READY shows and Open is enabled again) |
| `/containers` | All Docker containers on the host, each running one with its CPU, memory and processes now (from the daemon's container samples) and a link to its charts |
| `/costs` | What each agent spent, as its own OpenClaw priced it with the rates Rev4a syncs: today / 7 / 30 UTC days, by day, by agent, by model, the most expensive sessions, the calls that could not be priced, the DeepSeek band now, **metered at the proxy** next to **recorded by the agent**, per agent (the proxy counts every call it carries, the agent only what it recorded; the page counts the larger and marks an agent the proxy saw clearly more of), and a check against what DeepSeek and OpenRouter actually billed (read by the daemon every 5 min into `costs.db`; each agent's own figures, the ones Home's "Spent today" shows, are also in its panel, COSTS). Spent on this page is the larger of the two figures per agent, so it can be higher than Home's; calls without an agent header ("Unidentified callers") are listed but not counted in Spent. Calls made with a ChatGPT subscription (provider `openai`, or the legacy `openai-codex`) or on a Claude plan through Claude Code (provider `claude-cli`: the daemon stores an `anthropic` turn of an agent whose Claude Code rule is on under that name, from the day the rule was seen on; a daily model `anthropic` row that carries a cost above 0 is paid API spend and is never relabelled (sessions and cron runs have no cost guard and never feed Spent), and the days are closed at the last day the rule was seen on; remaining approximation: a zero-cost `anthropic` row on the day of Connect or Disconnect counts as plan usage) are covered by the plan: they are in no spend figure and each plan has its own section, **ChatGPT subscription** and **Claude subscription** (shown only when the range has some): tokens, calls and the **API value** — what the same calls would have cost at API prices (OpenClaw's price catalog, refreshed every 6 hours; OpenAI prices for the ChatGPT section, Anthropic prices for the Claude section; OpenClaw stores a Claude Code turn with cost 0, so the Claude section usually reads "no price" for the API value while its tokens and calls are shown) — by agent and by model; a model with no price shows "no price" (never $0) and the headline then says "at least"; it links to `/subscriptions` for the quota windows |
| `/system` | The host machine: CPU, memory and swap, storage per filesystem — current values and 1h / 24h / 7d / 30d history (from `metrics.db`, sampled by the daemon every 30 s); **Agents and containers**: what Docker holds on disk, and one row per container — CPU, memory, storage, processes — that opens to its own CPU / Memory / Storage charts (sampled every 60 s; a recently seen row without current statistics says "no data", and stale current figures are hidden; each agent's numbers are also in its panel, RESOURCES); and the recent alerts: the machine's CPU, memory and disks, plus a container with 1000 or more processes on two samples in a row or 90 % of Docker's memory on five (at most one alert per container and rule per hour) ; a **Memory limit** warning appears only when the running containers use 85 % or more of Docker's memory and a running agent has no limit or its limit could not be read; Recent alerts also lists `container_oom` (a process killed for lack of memory in an agent) |
| `/remote-access` | Current setup, guarded access presets, exact-edit confirmation with proxy acknowledgement, explicit restart and running-agent recreates. In Setup beside Config; System keeps a compact status row and Manage link below host charts |
| `/config` (Agent defaults) | Besides the environment variables, a *Default memory limit for new agents* picker, **No limit by default**. It only prefills the create wizard's memory limit; it never changes an agent that exists (`agent-defaults.json`, `GET`/`PUT /api/agent-defaults`) |
| `/config` (Time zone) | A *Time zone* card: the zone the dashboard shows times in (Costs, System, Crons, Context, the header clock, the live feed and the session drawer), with dates in each viewer's own format. Until one is saved it is **From REV4A_TIMEZONE (<zone>)** when that variable holds a valid zone, otherwise **Server default (<zone>)**; *Use server default* forgets a saved one. Saved on its own (`settings.json`, `GET`/`PUT /api/settings`), applies at once |
| `/wizard` | First-run setup wizard (Welcome → Access → Providers → Agent → Ready) |
| `/workspace` | File explorer with a lazy tree (one folder at a time, "Show hidden files" switch, lock badge on read-only places, `?agent=&file=&hidden=` in the URL) + editor — agent container workspaces; a banner appears when the agent changes the open file; PDF, images, SVG, audio and video open read-only; logs and files over 2 MB open on their last 256 KB (read-only, "Load earlier"); every file has a Download button; a save never overwrites a newer version from the agent without asking |
| `/lineage` | Sessions of every agent container as a tree: container (stopped ones marked) → `main` → sessions → sub-agents (any depth) → cron runs, with OpenClaw's real status, model, tokens and cost ("not priced" when unknown). Filters: agent, period (15m · 1h · 6h · 1d · 7d · 30d · all, default 1d, remembered per browser), active only, no cron. Click a node for the session drawer. |
| `/memory` | Context: per agent, read-only, what OpenClaw injects into the prompt (size, truncation against the caps), the `memory/` files and the Rev4a rules file; file names open in Workspace |
| `/gateway` (model rows) | Each model has a **Details** (`⋯`) action opening a modal with what is known about it: description, price and the provider it comes from, architecture and parameters (mixture of experts, layers, hidden size, attention heads, vision encoder, precision, weights on disk), reasoning modes, capabilities, benchmarks with their sources, licence and popularity. The facts come from the model's card on Hugging Face and — for the vendor's own size claim and benchmarks — from hand-curated entries that always cite a source and a date; nothing is estimated. |
| `/crons` | Scheduled cron jobs — auto-discovered from every running agent container (Docker containers with `AGENT_ID` label), on/off toggle, run history per job; agents are shown by display name |
| `/credentials` | Third-party tool credentials (GitHub, Trello, Vercel, Supabase, Notion, MongoDB) — SQLite vault; each credential has a switch per agent that delivers it through OpenClaw (environment entries and skill config for Trello, Notion and Supabase, a connection string plus `mongosh` and a shared skill for MongoDB, the managed GitHub identity, the Vercel CLI's own files) |
| `/subscriptions` | Subscription accounts per agent, one accordion per provider: connect an agent by device code (ChatGPT: Rev4a shows a link and a code, you enter the code on OpenAI) or by a guided sign-in (Claude, Experimental: Rev4a installs Claude Code, opens Anthropic's page and takes the code you paste), see until when each agent is connected, see the account's usage limits (5 hours and weekly, with reset times, for ChatGPT and for Claude), see the model each agent uses (read-only, with a link to the agent panel where it is chosen), disconnect. The tokens stay in the agent's volume; Rev4a stores nothing |
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

### Spend and loop alarms

The daemon warns when an agent burns money or tokens abnormally. The case that shaped it (2026-10-07, measured by the
proxy): a session context of ~560k tokens against a 200k window, a compaction that timed out on every Telegram
retry, 1,417 calls in 14 hours (~101 an hour, ~64k prompt tokens each, 12 errors), $6.81 spent, while OpenClaw's own
records showed 92 of those calls. **Alarms only: nothing is blocked or throttled.** One SQL pass runs after each costs
pass (every 5 min; no Docker, no network, no CLI call) in `lib/spend-alerts.js`. The spend rules read ONLY the proxy's
metering (`proxy_usage_hourly`), never the costs agents recorded, because OpenClaw does not record a failed compaction.

| Metric | Fires when |
|---|---|
| `spend.session` | a session (cron runs excluded: their `total_tokens` is a run's usage) holds 100 % or more of its model's context window (`agent_sessions.context_tokens`, from `sessions.list` `contextTokens`; 400 000 tokens when the window is unknown) and was updated in the last 6 hours. OpenClaw compacts a session before its window (it keeps a reserve of at least 20 000 tokens), so a healthy session sits at 85-90 % at most and never alarms; one past its window is a compaction that is failing (the 2026-10-07 session was at 280 %). One warning per session. It resolves only when the session is seen again (updated after the alarm) under 90 % (the share minus 10 points, at least 5 %), never because it went idle |
| `spend.loop` | in the last full hour errors + calls without usage are at least 10 and at least 50 % of the calls, with at least 1 000 000 prompt tokens |
| `spend.unusual` | the rolling last 24 hours cost (tokens for an unpriced model) is over 3x the agent's median day over its active days (at least one call) of the previous 28, and over $2 (20 000 000 tokens). With fewer than 3 active days of history only a higher floor applies, $5 (50 000 000 tokens), and at most one alarm per 24 hours; otherwise the cooldown is 6 hours. When the median cost is 0 but the median tokens are not (a model priced only lately), tokens decide. A weekly batch has 28 days to show 3 active days |
| `spend.unaccounted` | a vendor's USD balance dropped over the last two readings by more than 2x the proxy-metered cost of that provider in the window and more than $0.50. A top-up is ignored. Only USD vendors are compared (the proxy meters in USD; another currency is skipped, not converted). Never twice for the same newer reading, and no "back to normal" note (a drop that stops is not news). Alarms are counted per vendor over a rolling 7 days, not reset by a clean pass: after the 2nd, at most one per 24 hours, and the message says the key may be shared with another install |

Regular work stays silent: an office-hours orchestrator, a nightly batch, a 24/7 steady orchestrator, a watchdog cron
every 5 minutes (its day never reaches the floor) and an unpriced orchestrator are judged against their own active days.

Behaviour: one alarm per agent and rule per hour at most (6 or 24 hours for `spend.unusual`, see above); a "back to normal" note after two
clean evaluations (not for `spend.unaccounted`); the state is in `alert_state` (events.db, rows `spend:<rule>:<scope>`) and is written only after the
alarm was recorded, so a restart repeats nothing and a failed delivery sets no cooldown. **Snooze 24 h** (System ->
Recent alerts and the agent panel, under COSTS) calls `POST /api/alerts/snooze`; a snoozed agent is evaluated but not alerted,
and the button then reads "Snoozed until <time>" from the server. Missing data never reads as zero: the proxy rules are
skipped for an hour during which the proxy paused its metering (marker file `proxy-metering-gap` next to `costs.db`; a gap in
the last 2 minutes of an hour also touches the next one) and those hours stay out of the medians; the balance rule is skipped
when the reading is older than 2 hours. Each alarm is a `system_anomaly` event with `agent`, `container` and `scope` in its
data, and a Telegram message when Telegram is configured (same variables; sender `lib/alerts-send.js`, shared with `lib/alerts.ts`).

Thresholds: `REV4A_SPEND_*` (see `.env.example`; zero, negative or malformed values fall back to the default);
`REV4A_SPEND_ALERTS=false` turns the rules off. Rule `spend.session` assumes OpenClaw's `totalTokens` is the current context
of the session, not a running total. The pass reads at most 29 days of `proxy_usage_hourly`, history only for an agent over a floor (no full scan; about 4 ms, 25 ms in the worst case, on 20 agents x 3 models x 400 days). A delivery that fails is logged and skipped for that alarm only (nothing stored, so the next pass tries again); the other rules still run.

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

Before preflight, `rev4a serve` probes the dashboard port. If it is busy, the CLI
only signals processes recorded for that port in `server.pid` or `run.pid` under
`<REV4A_DATA_DIR>/data` with a matching OS start time. If the port stays occupied,
startup stops and shows listener details when available. A listener left behind by a
version that predates these records is treated as another program. On a standalone
install, stop that older Rev4a instance through its original supervisor, or use
`PORT=<n> rev4a serve` or `rev4a serve --port <n>` to choose another port.
The port must be an integer from 1 through 65535.

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
carry: `rev4a serve` reads `~/.config/rev4a/.env` itself, and a non-empty key there wins
over the same key set here (an empty `.env` value does not hide a non-empty value set
here, and neither first-run setup nor startup generates a secret the service already
provides) — so secrets such as `REV4A_PASSWORD` or `REV4A_TOKEN`
belong in `.env` (or `/config`), not in the drop-in. It is also the only place for the
variables read before `.env` is loaded (`REV4A_DATA_DIR`, `REV4A_DOCKER_WAIT_SECONDS`,
and `REV4A_DOCKER_AUTO_INSTALL`). Set `REV4A_DOCKER_AUTO_INSTALL=0` here to skip
Docker auto-install for the service.

```ini
[Service]
Environment=REV4A_DOCKER_WAIT_SECONDS=180
Environment=REV4A_DOCKER_AUTO_INSTALL=0
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

### PULSE

PULSE is the floating assistant in the dashboard. It needs a provider API key
configured in Gateway and at least one enabled Gateway model. Agents can use
connected ChatGPT or Claude subscriptions without a Gateway key.

When Gateway offers no models, the panel keeps any existing messages, disables
the composer and shows **Open Gateway**. Once Gateway offers a model, the
composer becomes available without a page reload.

### Credentials (`/credentials`)
Store third-party service credentials and install them into agent containers.

- **SQLite storage:** `credentials.db` in the data directory. Secrets are held
  **unencrypted**; anything that can read the file has them in the clear.
- **Provider keys** are a separate store at `<REV4A_DATA_DIR>/data/provider-keys.json`, managed from the
  Gateway UI.
- **Six providers.** GitHub, Trello, Vercel, Supabase, Notion and MongoDB. A credential reaches an
  agent the native OpenClaw way: the token is written to the agent's OpenClaw **secret
  store** as environment entries (`SUPABASE_ACCESS_TOKEN`, `TRELLO_API_KEY` and
  `TRELLO_TOKEN`, `NOTION_API_TOKEN`) and the matching bundled skill is configured
  (`skills.entries`: a SecretRef `apiKey` for Notion, an `env` map for Trello, a plain
  switch-on for GitHub) so it turns eligible by itself. Rev4a writes no TOOLS.md row; the
  agent finds the service available from its environment and its skills. `supabase` reads
  its variable natively.
- **MongoDB is a connection string plus a CLI.** The string (`mongodb://` or `mongodb+srv://`, checked when it is saved) goes into the secret store as `REV4A_MONGODB_URI`: the usual name `MONGODB_URI` is dropped by OpenClaw's exec tool on purpose, so it would never reach a command. Switching it on, in this order: installs `mongosh` 2.13.0 under `/root/.local` in the agent (about 200 MB, so the first switch-on can take a few minutes; skipped when that version is already there; another version or a missing launcher is reinstalled; the install allows up to 5 minutes; on failure nothing else is written), puts Rev4a's shared skill `rev4a-mongodb` in the host's shared skills directory, writes the store entry and the skill entry (SecretRef `apiKey`), reloads, and asks `openclaw skills info rev4a-mongodb --json` whether the skill is eligible. If it is not (or the answer cannot be read) the switch-on fails and the store and skill entries are removed again. If the check times out, the switch-on also fails but nothing is rolled back (the state is unknown); switch it on again to retry. The skill is hidden from the model on agents where the credential is off. Switching off removes the store entry and the skill entry; `mongosh` stays installed. Rev4a never tests the connection: the variable exists only inside commands run by OpenClaw's exec tool. Read-only access comes from the database user's built-in read role, not from Rev4a; the Credentials page says so. An agent row shows `mongosh <version>`, or "mongosh missing — switch MongoDB off and on" when the credential is held and no mongosh was found.
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
  operation. Editing a credential's secret re-delivers it to the agents it is on, two agents at a time (the declared 300 s maximum is for serverless platforms; self-hosted Rev4a does not enforce it). A
  credential switched on anywhere cannot be deleted until it is switched off. A failed delivery changes the card's status without changing its last successful delivery time; a credential never delivered shows "Never delivered".
- **Slow reloads (release note, bug16).** Config patches and secrets reloads now allow up to
  150 seconds each instead of 30, including switch-off and re-apply. If a patch times out
  but its values are already in the agent's config file, delivery continues. Otherwise the
  row says "The agent is still applying the change (OpenClaw is slow to reload); try again
  in a minute." An unconfirmed secrets reload also asks for a retry instead of showing raw
  exec output. Other steps keep their existing deadlines, including up to 5 minutes for
  a MongoDB CLI install. One switch can take a few minutes on a slow agent; self-hosted
  Rev4a does not enforce the route's serverless `maxDuration`. The UI keeps the active
  row loading and sibling actions disabled until the request settles.
  Each delivery waits for its exec transport to finish before releasing the agent config lock.
  After startup sync, a background repair switches on again, through the Switch's own path, the
  enabled assignments on running agents whose error contains "timed out or was killed" or
  "exit 137", one agent at a time once its Gateway is ready, with a success/failure log per agent.
  Two such credentials of the same service on one agent are left for the user to choose. This never delays dashboard startup. A success clears the
  error, so later starts skip it. Stopped agents keep their start-time re-apply.
  Token mismatches are also repaired at startup when Rev4a can verify that the running agent is free
  under its config lock. A switch-on is retried only if it is still the sole enabled profile of its
  service and still has the mismatch error. If another enabled profile of the same service was
  delivered, the retry clears the old profile's pending removal and preserves the delivered credential.
  A successful container removal also attempts to clean the old files and TOOLS.md row.
  Other failures and pending removals retain the lifecycle consistency pass and manual
  **Redeliver** / **Retry removal**. This fix changes no stored format or version
  requirements and is safe to roll back to the preceding release.
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
Use a ChatGPT Plus or Pro (Codex) subscription, or a Claude Pro/Max plan (through Claude Code), in an agent. One accordion per provider, ChatGPT first: closed each says "N of M agents connected" and the account email(s) with the plan ("Plus", "Pro"); open it lists the models the account offers (name, context) and one row per agent with its state (Connected until a date, Not connected, Stopped, Error), **Connect** / **Disconnect**. The Claude accordion carries an **Experimental** pill and shows the usage limits of the plan (5 hours and Week bars, one tiny Claude Code call per account, cached 3 minutes, **Refresh** bypasses the cache; the agent panel's Claude line shows the windows left); it closes with "Usage counts against your own Claude plan. Anthropic's limits assume ordinary individual use; for round-the-clock automation an API key is the safer choice." and a link to Anthropic's guide. A connected agent also shows its model read-only ("Model: gpt-5.6-sol · fallback deepseek-flash") and a link "Change in the agent panel" (`/agents?agent=<id>`).

- **Connect** opens a dialog: "Waiting for the agent…", then a link to OpenAI and a code to enter there with the ChatGPT account (expires in 15 minutes, with a countdown; Copy button). The code is 4 characters, a dash and 5 characters (for example `LBVC-84CXA`). The dialog polls the login every 2 s and ends in "Connected as <email>" or the error with Retry; reopening it (or a second tab) on an agent whose login is running resumes it, and if the dashboard restarted meanwhile it says "The login was interrupted. Start again." with a **Start again** button. The login starts only when the agent's Gateway is ready, and an agent that is being updated, recreated, edited, restored or backed up refuses it (409). While a login is starting or waiting, the agent itself is busy for up to the 15-minute code lifetime: stop, start, restart, recreate, update, edit, model save and token rotation answer 409 or skip the agent until the login ends or is cancelled.
- **Connect on Claude** is a guided dialog with no terminal: Rev4a installs Claude Code in the agent on the first connect ("Installing Claude Code in the agent… This takes about a minute, only the first time."), then shows two steps — "Sign in on claude.com with your Claude account." with **Open Anthropic's sign-in page** or **Copy link** to open it in another browser or device (if the clipboard is refused the link is shown to copy by hand), and "Paste the code Anthropic shows." with a code field and **Continue** ("Checking…"). The code is sent once and dropped: it is never stored in the browser, the URL, a log or a toast. States: Starting…, Checking the code with Anthropic…, Connecting the agent…, Connected (email and plan) with "Choose a Claude model in the agent panel.", or Anthropic's own failure sentence with **Start again**. Cancel (or closing the dialog while it runs) stops the login; once the code is submitted ("Checking the code with Anthropic…", "Connecting the agent…") Cancel is hidden and closing the dialog only hides it, because the job finishes on its own (connected or failed) and the row refreshes when the dialog closes. If the start request does not answer within 20 s the dialog shows the failure and also cancels any login the server may have created. A wrong code ends that login; starting again gets a new link.
- After either sign-in, Rev4a refreshes the row. An agent with no primary or fallbacks gets a model automatically using the same selection as **Set up the model**. The dialog closes and the row shows **Setting the model…**. A toast names the model after it is saved. If setup fails, the row shows the reason and **Choose in the Model section**. When Claude asks the account to accept updated terms during sign-in, the dialog explains the requirement and setup is skipped.
- The Claude rows read their state from `claude.state`: Connected until a date (with email and plan), "Not connected" (Claude Code missing or signed out) with **Connect**, "Signed in, not in use" with **Reconnect** and **Disconnect**, or "Needs a new sign-in" with **Reconnect** and **Disconnect**. An agent whose Claude Code is signed in with an API (Console) account shows Error with the reason and **Disconnect**, which signs that account out so a Claude plan can be connected. Each async action shows its own loading state ("Connecting…", "Disconnecting…").
- The page is asynchronous: the agent rows (with their display names) appear at once and each loads its own status, the models load apart, and every row can act while the others load. **Disconnect** runs in the background (the row shows "Disconnecting…" while the rest of the page stays usable).
- **Choose a model** in Create when the catalogue offers one, use **Set up the model** for an agent without a primary, or set one manually in the agent panel's **Model** section. Setup picks `gpt-6.1-sol` for ChatGPT or the first Sonnet for Claude when available, then falls back to the first model from that provider. In the **Model** section, the primary picker and each fallback picker offer the groups "Rev4a proxy", "ChatGPT subscription" and, when the agent's Claude plan is connected, "Claude subscription" ("Loading subscription models…" shows until they arrive). Any combination is allowed. Picking a subscription model as primary while no fallback is set pre-fills the previous primary as the first fallback ("Used when the ChatGPT subscription reaches its usage limit", or the Claude wording for an `anthropic/` model), which you can remove, so the agent falls back to the Rev4a proxy by itself. **Disconnect** first reverts or clears the subscription model, signs the account out, then (ChatGPT only) stops the agent's Codex runtime (the app-server OpenClaw runs the ChatGPT models through, which would otherwise keep running after the sign-out). No restart: the agent stays up, and connecting again starts a new runtime on the first subscription turn. A Claude disconnect also removes the Claude Code runtime rule and signs out with Claude Code's own `auth logout`; the binary stays installed for the next connect. Connecting a Claude agent also sets `IS_SANDBOX=1` in the agent's Claude Code settings (`/root/.claude/settings.json`, merged, never overwritten) so manual compaction ("Compact") works as root; the daemon applies the same step to agents connected earlier, and Disconnect leaves the key in place. Connecting also switches off, on Claude runs only, the tools no agent uses there (`tools.byProvider.anthropic.deny`, written only when absent, and once at dashboard startup for agents connected earlier); this saves about 16k prompt tokens per turn, other models are unaffected, and the agent can switch a tool back on itself.
- Choosing a Rev4a model as primary in the agent panel is an explicit choice and **replaces** a subscription primary; the agent stays connected and the subscription model can be chosen again in the agent panel.
- The usage limit is the account's: it is shared with the owner's own use of Codex. Subscription calls are not counted as spend anywhere (Home, the Costs page totals, the agent panel, the system-health high-spend check): the Costs page shows them in their own *ChatGPT subscription* (and *Claude subscription*) section with their API value, the saving the plan gives. Rev4a never gives an agent an OpenAI API key, so every `openai` call is treated as a subscription call; an operator who adds their own OpenAI key by hand would see those calls there too.
- **Claude usage limits.** The Claude accordion shows the same block (5 hours and Week). Claude Code reports the plan's usage only while it answers, so each read is one tiny Claude Code call in a running connected agent (about 1.5 s and a few hundred tokens of the plan (Haiku, no tools, no session), measured live 2026-11-14), made at most every 3 minutes per account (the result, and a failure, is cached; **Refresh** bypasses it). The agent panel's Claude line shows the windows left, like ChatGPT's.
- **Usage limits.** At the top of the accordion, one block per connected account: "<email> · <Plan>" and a meter for the 5-hour and the weekly window, each with "N% used · resets at HH:MM" (today) or "resets Thu 15 Oct, 09:45" (later), in your local time. The meter turns to a warning at 80 % and to danger at 100 %, where a line says the connected agents use their fallback model until the reset. It loads after the rows (the first read takes 11 to 50 s on a slow host and holds about 360 MB in the agent, so the result, and a failed read too, is cached 3 minutes per account on the server). The block refreshes by itself every 60 s while the page is visible and when the tab gets focus, which only re-reads that cache; "Updated N min ago" shows the age, and only **Refresh** (one per account, each with its own loading state) bypasses the cache. A failed read shows an error with Retry. Connect and disconnect do not drop the usage cache (the quota belongs to the account, which they do not change); they do drop the model lists and the account-to-agent lookup (60 s).
- The agent panel's MODEL section has, under the pickers, one read-only line per connected provider. ChatGPT: "ChatGPT Plus · 5h 86% left · week 98% left" (or "Subscription: ChatGPT Plus, connected" while the usage loads or when it cannot be read; at 100 % of either window "Limit reached until <reset>: using <fallback model>"). Claude: "Subscription: Claude Pro, connected · Experimental". With no provider connected it says "Subscription: not connected — connect it on Subscriptions" (linking here). An `openai/` or `anthropic/` primary on a connected agent is healthy (it is not in the Rev4a catalogue on purpose); on an agent that is not connected to that provider the panel warns.
- **Rollback.** Disconnect **every** agent here before rolling Rev4a back to 1.14.0, and disconnect a Claude-connected agent before rolling back to a version that predates the Claude accordion (the bare `anthropic/<id>` and the Claude Code rule are understood only here; another version would not show or revert them). On 1.14.0 a subscription model may look like the Rev4a proxy model of the same name (`gpt-5.6-sol`, `-terra` and `-luna` are also catalogue models), with no warning, and any save there turns it into the paid proxy model; 1.14.0 also cannot disconnect. An `openai:` API-key profile an operator added by hand is not a ChatGPT sign-in: it is left alone and does not count as connected.
- On the agent list a subscription model reads "gpt-5.6-sol · ChatGPT" for a bare `openai/<id>` and "<id> · Claude" for a bare `anthropic/<id>` (proxy models keep their plain name, and some share it, such as `gpt-5.6-sol`), with no chip of its own; with **no** fallback it shows the "NO FALLBACK" warning, because the agent goes silent at the usage limit. Whether the agent is connected is in its panel.
- **Disconnect** asks for confirmation and names the model the agent will use. When the agent has no replacement model, the dialog says it will have no model until you connect a subscription or add an API key. Rev4a clears the subscription model before sign-out, and the Agents page shows **No model** with **Connect subscription** so you can choose what to use next. A subscription model in the `main` entry of `agents.list` is also reverted or cleared. The dialog wording is derived from the default model only: in the rare case where the `main` entry holds a different model than the default, the message can differ from what happens to that entry (known limit). Rev4a verifies the model changes before signing out under a 60 s limit inside the agent, then checks that no ChatGPT profile or Claude sign-in remains ("The sign-out did not complete. Try again.").
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
- **Start and port setting (1.29.0)** — switching on a stopped agent with different port bindings opens **Start <agent>**: Move and start (cold backup and Recreate), Start as is, or Cancel. The job shows progress and errors. A warning **Ports: every interface** (or its current Control UI address) appears on the card and in the panel, beside the existing Recreate action for a running agent. An empty setting keeps Start unchanged and shows no pill. No rebuild happens without a click.
- TG channel status chip (green = connected, hidden if not configured)
- **No model** — the card shows this pill and **Connect subscription** when the agent has no primary. The detail panel shows the same action in its notice and in place of its **Open Control UI** button; the Ports section hides its Control UI shortcut and Browser access hides the invite link (approvals stay). Channel Manager disables adding a channel and keeps existing channels visible and removable. Saving a primary from the setup dialog or the Model section restores the regular controls at once; a primary set elsewhere restores them at the next model summary read.
- **Shared gateway token** — text input with Save & Sync. Changing the token saves it to `data/agents-token.json` and pushes it to every agent: running ones restart with it, stopped ones receive it on their volume and use it at their next start (before 1.30.1 stopped agents kept the old token, even across Recreate). Busy or paused agents are listed and keep the old token until the next save.
- **Control UI link** — the **Open** buttons go through `GET /api/agents/[id]/open-control-ui`, which redirects to the agent's published port: a one-time link on OpenClaw 9.x, the plain `#token=` link otherwise, with the token read inside the container. Local dashboards use a different cookie host: `localhost` (case-insensitive, also `localhost.`) opens on `127.0.0.1`; `::1`, `[::1]` and any `127.x.y.z` open on `localhost`, which resolves to both loopback address families. Both the page and the `gatewayUrl` fragment use that host, because cookies are shared across ports. LAN/public IPs and domains keep the dashboard host. When the dashboard is on plain HTTP on such a host, the agent's port also receives the Rev4a session cookie (cookies ignore ports), so **Open** first shows a modal (*Open the Control UI*): the risk in one paragraph, the SSH tunnel command (`ssh -L <port>:127.0.0.1:<port> user@<host>`) with Copy, **Copy tunnel link** (a link built for `localhost`, from `GET /api/agents/[id]/open-control-ui?tunnel=1`, issued only when pressed; the command reads only the port, through `?tunnel=port`), a link to the HTTPS guide, and **Cancel** / **Open anyway**. It is asked every time; nothing is remembered. On HTTPS and on loopback hosts there is no modal. The System page shows a warning card on plain HTTP and a compact **Remote access** status row linking to `/remote-access` (the dedicated page holds guarded presets, restart and individual running-agent recreates, from `GET /api/system/listen` and `/api/system/remote-access`). When an agent's port is published only on loopback (`REV4A_AGENT_PORTS_LISTEN=local`) or on an IP that is not the dashboard's own IP, and the dashboard is not on the server itself, the plain link cannot work: **Open** then shows the same modal in a variant (any protocol, https included) with *This agent's port is open only on the server itself. Use an SSH tunnel:*, the command, **Copy tunnel link**, the guide link and **no** *Open anyway*. A loopback dashboard opens directly. While the agent's Gateway is still starting the card shows a `STARTING m:ss` chip (`GET /api/agents/gateway`); while the Gateway answers 503 **Open** reads *Starting…* and is disabled. When it gives no answer at all (normal in the first seconds of a boot) the chip shows but Open stays enabled. After 10 minutes without readiness the chip reads NOT READY and Open is enabled again; a container in a restart loop reaches NOT READY too (the 10 minutes count from the first start Rev4a saw, not from each restart; they start again when Rev4a restarts). Only a real 503 disables Open; a failed, missing or unexpected readiness answer never does.
- **Agent creation wizard** — multi-step form at `/agents/create`.
- **Channel Manager** — each agent detail panel has a Channels section with Telegram configuration and pairing management. Pending requests (a sender's `/start` creates one) show an **Approve** button; approved senders show **Revoke** with a confirmation. Approved senders are OpenClaw's pairing store, not the agent config: on 2026.9.x the SQLite store, read and revoked through OpenClaw's own store functions (see [ARCHITECTURE.md](ARCHITECTURE.md)).
- **Browser access** — the detail panel section right after Channels. From OpenClaw 9.x each new browser must be approved once before the Control UI connects: the section lists requests waiting for approval (Approve / Reject) and approved browsers (Rename / Revoke), and the agent card shows a "browser waiting" badge. The **Open** buttons first ask the agent for a one-time link that pairs the browser with no approval, and open the plain token link when none can be issued (the agent is stopped, or the link fails). **Invite link** gives a link to send to someone else: their browser passes gateway auth and waits in the approval list until approved. The link carries the gateway token every agent shares; changing the agents token invalidates every link sent. All of it runs the OpenClaw CLI inside the container asynchronously.

**Control UI upgrade note (SEC-16).** A browser that paired an agent's Control UI on
`localhost:<port>` now opens it on `127.0.0.1:<port>`. The one-time link pairs it again
with no approval; the plain token link may ask for pairing approval once. The reverse
host change applies to dashboards reached on `127.x.y.z`. Existing data, configuration
and agent volumes are unchanged.

### Memory limit per agent

**The picker.** The wizard, the agent panel's Edit form and the Configuration page all use one component, `MemoryLimitPicker`: *No limit*, 1.5, 2, 3, 4, 6, 8, 12 or 16 GB (1 GB = 1024 MB; sizes above Docker's total memory are not offered when it is known), or *Custom…*, any size in GB (for example `2.5` or `2,5`, rounded to whole MB; from 0.25 to 1024 GB) shown with its exact value in MB (`= 2560 MB`). Custom is not capped by Docker's total memory: only the presets are hidden. Opened on an existing limit it selects the matching size, or Custom with that limit in GB. The API still takes MB (minimum 256 MB). Advice is version-specific: 9.3/9.9 retain a nonblocking 2 GB warning; exact 10.10 Create/Update require a finite cap of at least 4 GB after the bounded memory failures. Editing an existing cap remains an explicit operator choice, with the runtime advice visible. Unknown versions receive general planning advice. This is measured guidance, not a guarantee for every workload. When a limit is exceeded, Docker kills the process that uses the most memory (a memory hog inside the container was killed alone and the agent stayed up), and the agent restarts if it was the main process.

A memory limit is **always the operator's choice**: no agent gets one by itself, an update touches no existing agent, and the default is none. A Docker memory limit kills, it does not slow down: a process over the limit is killed by the kernel (and the agent restarts if it was the main one), so leave it empty for heavy workloads (headless browsers, builds) unless you know the figure.

- **Agent panel, RESOURCES** has a *Memory limit* row: `none`, or the usage against the limit ("896 MB of 2 GB", in the warning colour from 90 %). **Edit** opens the shared *memory limit picker* (below). Saving applies the limit **live** (`docker update`, no restart); swap is always set equal to the limit, so the limit is the total the agent can use. A value below the current usage asks for confirmation first, because it kills processes at once. **Remove limit** rebuilds the container (the agent restarts, no backup, the data volume is kept) because Docker cannot lift a limit on a running container; the usual edit banner follows it.
- A rebuild (update, rollback, recreate, edit) **carries the limit over**, including one set by hand with the docker CLI; the previous Rev4a silently dropped such a limit at the next rebuild. A restore never rebuilds the container (it only stops and starts it), so the limit simply stays.
- **Upgrade and rollback note.** Going back to an older Rev4a is safe for the data, but an agent that has a limit and is rebuilt by the older version (update, recreate or edit) **loses its limit**, because the older rebuild does not carry it. Set it again after upgrading.
- When the kernel kills a process for lack of memory (with or without a limit), the daemon records a `container_oom` alert (Recent alerts on the System page, in red; at most one per container per 10 minutes, with the number of kills in between) and RESOURCES shows "Out of memory <time>: a process was killed" for 24 hours.
- While a cold backup runs, the System page lists its helper container as "Backup of <agent> (manual | before update | before recreate)" with a *backup* pill; when the job ends the row disappears instead of staying as a stopped container.
- The System page lists **Orphan agent volumes** (`agent-*-data` volumes no container uses, with size and created time) only when there are any, each with a Delete button behind a confirmation. A volume whose agent is being recreated, updated, restored, edited or backed up is left out (its container is briefly missing), and one whose agent's last recreate, update or edit did not finish is listed as kept, without Delete, because a failed recreate leaves the data only there; the delete route checks the same thing again right before removing. Any unused `agent-*-data` volume is listed, also one Rev4a did not make (for example from another tool), which is why Delete asks for confirmation. Nothing is removed automatically. A create that fails after `docker run` now removes its own container and volume; the list is for volumes left by older releases or by an agent removed outside Rev4a. A create waits 300 s instead of 120 s for the Gateway when the image runs under emulation.
- The System page shows a warning only when the running containers' memory is at 85 % or more of Docker's total memory **and** at least one running agent has no limit or its limit could not be read, with links to those agents. The picker keeps the preset of the agent's current value visible even when it is above Docker's total.

### Agent Creation Wizard (`/agents/create`)

**Step 1 — Template:** Select an agent template from `agent-templates/`. Each template is a directory with AGENTS.md, SOUL.md, MEMORY.md, and optionally BOOTSTRAP.md files.

Available templates:
- **Atlas** — general-purpose development agent
- **Argus** — security and audit agent
- **Prometheus** — client-facing project delivery agent
- **Custom** — blank slate. On first run, the agent runs a bootstrap ritual: introduces itself, learns who the user is, and together they define name, personality, tone, and boundaries. The agent writes SOUL.md, IDENTITY.md, and USER.md, then deletes BOOTSTRAP.md. No preset identity, fully user-defined.

**Step 2 — Config.** Enter an agent name, an optional port and an optional **Memory limit**. The memory picker uses the Configuration page's default and sends the chosen size in MB as `memoryLimitMb`. The first offered model is pre-selected. If the catalogue is empty, you can deploy and set up the model afterwards.

**Memory check** below the picker shows how much Docker memory the new agent needs.
It refreshes after valid limit changes and when you choose **Create Another**.
If Docker has too little memory, the breakdown shows the new agent's reservation,
what the running agents and containers account for, and what is kept free.
It suggests which agent to stop when one is enough, or
how much memory to give Docker. On Docker Desktop, it includes the settings path.
Use **Check again** after making a change. **Deploy Agent** runs a fresh check.
If it refuses for insufficient memory, the wizard returns to Config with the
latest breakdown. Update refusals also show the numbers and suggested actions.

**Step 3 — Deploy.** `POST /api/agents/create` creates the container and returns its port and model setup status. With a primary configured, the success screen offers **Open Control UI**. With no primary, **Set up the model** opens the agent panel and offers ChatGPT, Claude (Experimental), and **Use an API key**. Unsupported images use the Gateway path. The subscription flow selects a first model from the agent's account after sign-in. The API key flow shows a link back to the agent's Model section after any key is saved. Browser Access keeps device approvals visible and hides **Invite link** while the primary is unset.

**Post-creation pipeline:**
1. The container boots with the newest supported OpenClaw version downloaded here, `openclaw-agent-base:<version>`; the create answers `409` when none is — see [Agent Templates](#agent-templates) below.
2. OpenClaw gateway starts automatically with `--allow-unconfigured`, generating its own default config.
3. The route waits for the gateway to finish starting with `waitForGatewayReady()`, up
   to 120 s (300 s when the image runs emulated, i.e. its architecture differs from Docker's): `/startupz` has to report `started`. A 503 (starting or draining), a
   non-JSON 200 or no answer all mean "not yet".
4. Once ready, the route writes:
   - `gateway.controlUi` with the browser-origin policy (`withControlUiPolicy()` in `lib/agent-setup.ts`): the Host-header fallback on, so the Control UI is accepted from the host the browser connected to — a public IP is refused without it — while pages from other origins are refused; an `allowedOrigins: ["*"]` list and the retired `dangerouslyDisableDeviceAuth` are dropped, any other allowlist is kept. Recreate re-applies the policy. Each new browser still needs a one-time device approval
   - `agents.defaults.model` with the selected primary and fallbacks, when a model was requested.
5. `rev4a serve` generates the shared Gateway key at startup when it is missing. At create, the route builds `models.providers.rev4a` with `buildRev4aProviderConfig()` and writes it with `openclaw config patch --stdin`. If the key is unavailable at create, the next successful sync after it becomes available writes the block.
6. The agent's Control UI is reachable at `http://<host>:<port>#token=<gateway-token>` in direct mode. [Domain mode](#1300--caddy-domain-mode) manages a separate HTTPS hostname per agent. You can also configure your own reverse proxy to the published port.

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
| **Backup** (Backup Now) | the agent panel's **Backup Now** button calls `POST /api/agents/[id]/cold-backup`: the agent is stopped, `/root` (excl. npm cache) is archived as `.tar.gz` in `<data>/backups`, then it starts again. `/api/agents/[id]/backup` only lists (`GET`) and deletes (`DELETE`) backup files |
| **Where backups are** | Plain files `agent-<id>-*.tar.gz` in `<data>/backups` (default `~/.config/rev4a/backups`, mode 0700; `$REV4A_DATA_DIR/backups` when set). Copy them like any file, safe while Rev4a runs: `cp ~/.config/rev4a/backups/agent-<id>-*.tar.gz /somewhere/`. A Docker prune cannot delete them. Releases before this one kept them in the Docker volume `rev4a-backups`; at the first start Rev4a moves them into the folder in the background (one verified file at a time, free space checked first; the System page shows a one-line notice while it runs or if it stopped). Until then both places are listed and usable. A second Rev4a instance on the same Docker (a test instance) must set `REV4A_LEGACY_BACKUP_VOLUME` to another volume name, or it would move the real backups into its own data dir. A value that is not a valid Docker volume name disables the legacy side altogether (no migration, no volume lookups; one line in the log): it never falls back to `rev4a-backups`. `scripts/backup.sh` leaves `backups/` out of its archive (it can be gigabytes): copy the folder separately |
| **Cold backup** | stop → archive `/root` (excl. npm cache) as `.partial` in a helper container → read the archive back → rename → start again if it was running. Other operations on the agent answer 409 meanwhile. Survives a Rev4a restart. This is what **Backup Now** runs (`POST /api/agents/[id]/cold-backup`) |
| **Update** | the agent panel's OPENCLAW VERSION section, when a newer supported version is downloaded: wait up to 5 minutes for the existing Gateway to finish starting (the row stays `pending`, with "Waiting for the agent to finish starting…") → count transcript events and cron jobs (one unreadable cron list retry after 5 seconds) → cold pre-update backup → recreate on the new version (its data migrates one way) → wait for that version (a slow start keeps being waited for in the background, up to 40 minutes in all) → check nothing went missing. Unused agent images are removed afterwards. A failed or interrupted update that stopped before its verification (a slow start, or Rev4a restarting mid-update — never a recorded verification failure, a version mismatch or an interrupted rollback) and whose agent is later proved fine (target version, Gateway ready, baseline verification passes) is shown muted with its resolution and without Roll back; **Update history** (collapsed) lists the last 20 attempts. Before the resolution is stamped Rev4a re-applies its own config and provider block to the agent (best-effort; a failure is logged and named in the resolution text). A resolved failure of the latest update keeps a secondary **Roll back anyway…** button: its confirmation states the backup date and age and the version it returns to, says that everything the agent did since is lost, and stays disabled until the agent's name is typed. When the pre-update backup has been deleted from the Backup section, no Roll back is offered: a muted line says going back is no longer possible, and deleting that very backup first warns that it is the one the Roll back needs |
| **Rollback** | after an update: stop → restore the pre-update backup → recreate on the previous version. Everything since the backup is lost, including a recreate or restore done after a failed update: the panel names that job and its date next to the failure and in the confirmation. This is the only way back: 2026.9.9 moves the OpenClaw state database from schema 16 to 19 and 2026.9.3 refuses to start on that volume (verified), so recreating on the older version without restoring the backup does not work |
| **Restore** | stop → replace `/root` with the backup (real wipe incl. dotfiles) → restart. Software/image untouched — only data goes back in time |
| **Recreate** | auto-backup first (aborts if it fails) → rebuild on the agent's own OpenClaw version (`openclaw-agent-base:<version>`, tagged or pulled when missing) keeping the volume. The cold backup's 30 s stop is the graceful stop; exit 137 or kill fallback keeps a lease warning in the job message, including after failure/interruption and reload. An image with no version label and no version tag keeps its current image id (the version read inside the container is display-only), and the current image is kept when Docker cannot be read. Never changes version |
| **Restart** | `docker restart` with the current bindings. For a stopped agent whose ports differ from the Remote access setting, the API returns `409 ports_differ` without a port choice and the panel asks what to do. `ports: "as_is"` restarts the existing container and `ports: "move"` returns `202` and starts a Recreate job |
| **Delete** | **destructive**: removes container **+ volume + all backups**. Cannot be undone |

**Release note (2026-11-07).** Edit, removal of a memory limit and Recreate allow a
running Gateway up to 60 seconds to shut down before removing its original container
by ID (ownership is verified). Shutdown/removal is bounded to 90 seconds; a forced
fallback is logged and retained in the job's message (`error`, even on success), with
an owner-lease warning. Other lifecycle paths retain their previous behavior. Existing
leases are never deleted by Rev4a. Config inspection masks secret-named keys and
credential locations: channel accounts/service accounts, provider keys and all headers,
all environment values, skill API keys, credentials and auth profiles, including arrays.
Invalid JSON or a non-object root returns an error without the raw content. After
Connect, loading accounts are retried every 5 seconds for up to 3 minutes, including an
in-flight request/body deadline. Available models remain usable while another account
loads; after the deadline the page explains how to retry.

These changes do not migrate or rewrite existing databases, config, environment files,
provider keys or agent volumes. There is no startup scan or added startup delay. Older
agents use the same Docker stop signal and remain manageable. Rolling Rev4a back can
read the same data; it restores the earlier shutdown and config-inspection behaviour.

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
- Starts OpenClaw gateway with `--allow-unconfigured`. The token is passed in `OPENCLAW_GATEWAY_TOKEN`, not as `--token`, so it is no longer in process listings (`ps`, `docker top`) on the host or in the container (`/proc/*/cmdline`). Agents on OpenClaw 2026.9.3, and on a 2026.9.9 image built before 384bd8e, still use `--token` until they are recreated or updated. This removes the argv exposure only: processes in the container run as root and can still read the environment and the token file, and the gateway's child processes now inherit the live token in their environment; the token is still in the container environment (set by Rev4a at create, visible to `docker inspect` and every `docker exec`) and in `/root/.agent-token`, both readable by root only inside the container: `openclaw gateway --bind lan --port 3000 --auth token --allow-unconfigured`. `rev4a-gateway-auth` reads `openclaw.json` first: if it sets `gateway.auth.token`, `gateway.auth.password` or a non-token `gateway.auth.mode` (config beats the environment), or cannot be read, the entrypoint keeps `--token "<token>"` and logs why. Rev4a never writes `gateway.auth`.
- The image is multi-arch (amd64 + arm64) from the 384bd8e build on: an agent created or recreated on an Apple Silicon Mac or an ARM server pulls and runs the native build. 2026.9.3 (28cf675) and older tags are amd64 only and run emulated on ARM hosts; on a Mac the native image arrives after the new 2026.9.9 build is downloaded (NEW BUILD) and the agent is recreated or updated; a retag of a pre-multi-arch `:latest` copies only amd64. Agents keep their current image until recreated or updated. Files an agent installed under `/root` (`/root/.local`, global npm packages with native addons) were built for the old architecture; a volume moved to another architecture may need them reinstalled.
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
- Scans providers with keys in `<REV4A_DATA_DIR>/data/provider-keys.json`
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
Only models whose provider has a key in `<REV4A_DATA_DIR>/data/provider-keys.json` are synced.

---

## Key Gotchas

1. **`auth.mode: "none"` + `0.0.0.0:3000`** → OpenClaw refuses to bind. Must be `auth.mode: "token"`.
2. **Control UI token** comes from `/root/.agent-token` when present. The entrypoint uses the container's `OPENCLAW_GATEWAY_TOKEN` when the file is absent and generates a token if it has no usable value. If `openclaw.json` sets `gateway.auth.token`, the entrypoint explicitly passes the resolved agent token so it takes precedence.
3. **API routes need full build** — after editing `route.ts`, run `npm run build`. Server restart alone is not enough.
4. **Container directory listing** uses `docker exec` with `ls -1Ap` (single line per entry, trailing `/` on directories). Do NOT use `ls -la` with regex parsing.
5. **Subdirectory detection** for containers: `docker exec … test -d "$path" && echo YES || echo NO` before deciding to list or read.
6. **Service worker cache** (`public/sw.js`): if stale versions appear in the browser, delete this file and rebuild. Currently removed.
7. **Browser cache on workspace page:** the API uses `cache: 'no-store'` but the browser may still cache the rendered page. Use hard refresh (Ctrl/Cmd+Shift+R) or incognito mode to verify.

---

## Troubleshooting

### Login loops on plain HTTP

Since 1.28.0 the cookie mode is automatic: login, wizard completion and wizard reset pick the cookie flags from the scheme in the request's `Origin` header (`lib/session-cookie.ts`). An `https:` Origin, or none, gives Secure + Strict; an `http:` Origin gives a non-Secure Lax cookie, so plain HTTP by IP no longer needs a flag. A session made over HTTP and later used over HTTPS is upgraded once per tab by `POST /api/auth/refresh-cookie` (same token, Secure + Strict, never longer than its `exp`). After accepting the password, login checks `/api/auth/check` before navigating. A `401` keeps the page open: on HTTP it asks you to allow cookies for the site or serve Rev4a over HTTPS. On HTTPS the message asks you to allow cookies for the site. Wizard completion uses the same check before opening the dashboard; it writes the persistent completion marker and the legacy `wizard_done` cookie, not a login session. A failed completion stays in the wizard with a retry message. A network error or another error status from the session check shows a verification/retry message instead of blaming cookie settings.

**INST-4 update note:** this is a client-only check after login or wizard completion. Existing sessions, cookie flags, defaults, databases, configuration, provider keys and agent volumes are unchanged. There is no migration or startup scan; older agents and rollback remain compatible. Installs already affected receive recovery instructions on their next login; Rev4a does not change their transport settings automatically.

### "Could not start the backup" and the message names the data folder
Backups are written by a helper container that bind-mounts `<data>/backups` (`~/.config/rev4a/backups` by default). If Docker cannot mount that folder the backup fails and the message names the path. Typical causes: Docker installed as a snap (it cannot see hidden folders in $HOME), Docker Desktop without that path in its shared folders, SELinux (label denial on the bind mount) and Docker user-namespace remapping (the helper cannot write the folder). Fix: share the path with Docker, or set `REV4A_DATA_DIR` to a folder Docker can mount (move the existing `backups/` folder with it), then retry. A mount that works but cannot be written (SELinux, user-namespace remapping) fails the same way before anything is archived, with "the backups folder <path> is not writable from the container"; Rev4a does not add the `:z` label on its own.

### Backups, updates or recreates fail with "the backups folder … is not writable from the container"
Docker with user-namespace remapping, or SELinux, may be unable to write `<data>/backups`, so every backup, update and recreate (they all start with a backup) fails with that write-check error before anything is archived. Fix: give the user Docker maps its root to write access to the folder, or move the data folder with `REV4A_DATA_DIR` to one Docker can write. Rev4a does not add the SELinux `:z` relabel on its own: relabel the folder yourself (`chcon -Rt svirt_sandbox_file_t <data>/backups`, or mount it with `:z` in your own setup).

### Old backups still in the Docker volume after an update
The migration of backups from the `rev4a-backups` volume to `<data>/backups` moves one verified file at a time. A file whose copy does not read back stays in the volume, is named on the System page and in the logs, and the migration goes on with the next file (the volume is then kept, with those files in it). If it stopped because Docker did not answer (Docker Desktop started after Rev4a), it tries again every 5 minutes on its own; other stop reasons resume at the next start.

### "Restore" (scripts/restore.sh) and agent backups
`restore.sh` never deletes `<data>/backups`: it sets the folder aside before the swap and puts it back file by file (a `backups` that is a symbolic link is left where it is and recreated after the swap), and if anything fails it prints where the kept folder is (`.rev4a-keep-backups.<pid>` next to the data folder). A file of the same name inside the restored archive does not replace a current one (it is kept as `*.from-restore-archive`).

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
1. Restart the dashboard with `sudo systemctl restart rev4a.service` under systemd or
   `rev4a restart` under a standalone `rev4a serve` supervisor.
2. If startup reports a port conflict, choose another port with `PORT` or `--port`.
3. Check whether `public/sw.js` exists and remove it if present.

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

### OpenClaw migration safeguards
Clicking Update immediately after Start now waits for the existing Gateway before reading
the baseline. The row stays `pending` for up to 5 minutes and shows
"Waiting for the agent to finish starting…". A timeout or a stopped container fails with
instructions to wait until the agent is ready and try again, before any backup or stop.
An unreadable cron list is retried once after 5 seconds. Button availability, existing
rows, stored statuses and data formats are unchanged; no repair of agent data is needed
for earlier attempts that failed before the backup.

Create and Update check the actual target version and Docker headroom before changing an agent.
For OpenClaw 2026.10.10, a selected finite cap below 4 GB is refused. Basic checks passed at 3 GB, but repeated CLI configuration/model checks
exhausted that cap; the remaining case passed at 4 GB. Larger workloads may need more. No limit remains unlimited, and the
Configuration default is unchanged. Stop other agents or increase Docker memory when admission
reports insufficient capacity; Rev4a never changes caps automatically.

Update distinguishes the evaluated upstream-owned retired cron from lost user jobs. Old cron-only
failures can be audited from their exact pre-update archive without overwriting the original failure.
After a successful 9.x to 2026.10.10 Update, Rev4a associates affected ChatGPT/Codex cron jobs
with the account only when exactly one OAuth profile is connected. This migration policy is
explicit: zero or multiple profiles leave jobs unchanged and retain the selection guidance.
Default jobs keep model/fallback inheritance; explicit models and existing account associations
are preserved. The original model is journaled in Rev4a before native selection. Lost responses
leave unfinished intent that later passes and startup/60-second background retries reconcile with
revision guards, including journaled pins on CLI routes that did not create an inference binding.
The journal is per agent, update ID and job ID, so rollback followed by re-upgrade adopts again.
Starting an Update atomically supersedes earlier unfinished journals. Adoption uses the Update's
lifecycle claim; background repair takes that agent's claim and only repairs the latest update's
journal, skipping busy agents until a later retry. A job is complete only after its original model
is restored. The Agents update result counts association only after verifying the persisted binding
to the intended account. Only routes known before mutation to use CLI execution may report
**no binding needed (model left/restored)** without a binding; failed or unverified selections
remain pending for retry and are not reported as repaired.

For the evaluated 9.3/9.9 to 10.10 upgrade, the confirmation explains legacy automation account
adoption. Subscriptions lists read-only account references for every connected ChatGPT OAuth
profile. A Crons run with the exact missing-account refusal links to its native automation settings
and explains the explicit selection, optional return to Default, and verification before resuming.
See [Automation account adoption](dev/GATEWAY.md#automation-account-adoption-on-openclaw-20261010).

Restore first checks a pinned copy of the archive, saves a cold recovery copy, and only reports
completion after the restored Gateway is ready. Recovery archives referenced by retained restore
history survive automatic pruning. Partial/interrupted jobs require review and retain recovery
information; they are never automatically extracted over newer work. The BACKUP panel shows the
phase, retained failure and recovery filename. Older completed restores without Gateway evidence
carry an explicit notice. Versioned archives are checked against the target's core schema ceilings.
Unknown targets, unrecognized metadata-free schemas, corrupt/newer formats and source archives still
in the legacy Docker volume refuse safely. Check temporary disk requirements in the API reference
before a large restore.

Extraction uses a persisted, uniquely named and labelled helper. On failure or timeout Rev4a
removes it and independently confirms absence before freeing the volume or deleting its pinned
source. The BACKUP panel shows `unresolved` cleanup and keeps lifecycle actions locked if Docker
cannot confirm removal or the direct restore could not confirm an agent stop. Failure messages
report stopped, still running or unknown agent state accurately.

On Rev4a startup, an active restore becomes interrupted for review. An extraction interrupted by
the restart becomes `unresolved`, names its helper and keeps its reservation and pinned source.
Startup makes no Docker cleanup calls; there is no periodic restore recovery scan, and historical
restore rows are untouched.

In Agents > Backups, **Resolve restore** opens a confirmation for an unresolved restore. On confirm,
Rev4a stops and removes only containers with that restore's agent and row-ID labels, independently
confirms absence, then releases the reservation and records the outcome. The button shows
**Resolving…** and disables sibling actions during the request. A cold-backup helper has no restore
label and is never selected; the agent container is never stopped or removed by resolution. If no
labelled helper remains, resolution still releases the reservation. If Docker is unavailable or
cleanup is unconfirmed, the state stays unresolved: restore Docker access and retry the button.
Resolution does not establish data integrity: review the current volume before starting the agent
or restoring its recovery backup. Do not downgrade Rev4a while cleanup is unresolved: older panels
do not understand this status.

A cron-retirement audit deferred because the Gateway was unavailable at startup is retried on
later Agents panel reads, at most once every five minutes, using the same archived evidence and
concurrency guards. The original failure diagnosis remains available.

OC-10 behavior changes: restore cleanup after a server restart is an explicit operator
action, restricted to restore-labelled helpers. There is no historical-volume cleanup scan.
Cron adoption journals are scoped to each update and repair pins even without an inference binding.
Only the latest update owns repair intent; a new Update supersedes older unfinished journals.
Repair and lifecycle operations are serialized, and no-binding routes are reported separately from
verified association. Default, empty and explicit model choices remain intact.
Repair skips agents owned by cold backups or other operations. A stale repair reservation is
cleared at startup without starting an intentionally stopped agent or disturbing a cold backup.
No-binding success requires a CLI route known before mutation; rejected or unverified selections
remain failed and retry later.
Existing configuration, credentials, agent volumes and defaults are not rewritten. New DB storage
is additive and idempotent; evaluation-build journals are copied once into legacy update scope 0
without deleting their originals. A transactional migration marker prevents writes on later opens,
including after a partial copy. Unowned legacy scope 0 is retained for audit/manual review rather
than background mutation. The first startup only marks active restores, with no Docker scan or
archive extraction; older agents retain their normal lifecycle controls. Previous releases can
read the original data and ignore the additive fields/tables, but cannot finish pending repairs or
honor unresolved reservations: finish cleanup/model repair before downgrading.

## BUG-23 update note: Claude account terms

Connected Claude accounts blocked by updated Anthropic terms now show guidance in the connect
dialog, Subscriptions usage block and agent MODEL line. Open claude.ai, sign in with that account
and accept there; Check again refreshes the account. After Open, the dialog and usage block also
check every 15 seconds while visible, for at most 5 minutes. Rev4a never accepts terms or drives
the notice, because Anthropic's Consumer Terms §3.7 forbid automated access and Claude Code
requires Anthropic's own account flow. A successful connection stays configured.

No database, configuration, environment, provider vault or agent volume changes are introduced.
Already connected accounts are detected on their next usage read without a migration or repair.
There is no startup scan or first-run workload; Connect adds only the bounded existing usage
probe (60-second in-container timeout). Older Claude Code notices with different text simply
keep the previous generic usage error and non-fatal connection behaviour. All response fields
are additive; the previous Rev4a release can still use the same stored data on rollback.
