# Agent Templates

## Base image: `openclaw-agent-base`

The image every agent container runs, built from
[`base-image/Dockerfile`](base-image/Dockerfile).

It contains Node 24, OpenClaw, `gh`, `jq`, `vercel`, `supabase`, the plugins
shipped with the image under `/opt/openclaw-plugins` (DuckDuckGo web search), and
the entrypoint. The OpenClaw release is the `OPENCLAW_VERSION` build argument, also
recorded as the `org.opencontainers.image.version` label:

```bash
docker image inspect openclaw-agent-base:<tag> \
  --format '{{index .Config.Labels "org.opencontainers.image.version"}}'
```

The agent's persistent volume is mounted at `/root`. Anything the image puts under
`/root` reaches only agents created on an empty volume. That is why plugins live
under `/opt`, why the entrypoint applies the image defaults on every boot, and why
Rev4a re-applies its own settings at create and recreate. Entrypoint behaviour:
[docs/REV4A.md](../docs/REV4A.md#agent-templates).

### Durable apt installs

Only `/root` survives a recreate, an OpenClaw update or a restore; an `apt-get install`
lands in the container layer and would be lost. The image makes it durable without
anyone keeping a list:

- `rev4a-apt` is installed as `/usr/local/sbin/apt-get` and `/usr/local/sbin/apt`
  (ahead of `/usr/bin` on `PATH`). It runs the real command with the same arguments,
  output and exit code. After a successful `install` it records the packages named on
  the command line (not their dependencies) as `name=version` in
  `/root/.rev4a/packages.txt`, and copies the apt sources and keyrings that are not part
  of the image, and the key files those sources name with `signed-by` / `Signed-By:`
  (absolute files outside `/root`), to `/root/.rev4a/apt/` keeping their paths. A successful `remove` or `purge` drops the entry.
  Simulations (`-s`, `--dry-run`, `--download-only`) and local `.deb` files are not
  recorded. A recording failure is one `[rev4a-apt]` line on stderr and never changes
  the exit code. The image's own apt files are listed in
  `/usr/local/share/rev4a/apt-baseline`, written at build time, and are not copied.
- `rev4a-packages-restore` is started by the entrypoint in the background just before
  the gateway, which never waits for it. It puts the saved sources back, finds the
  recorded packages dpkg no longer has, runs `apt-get update` and installs each one
  (`name=version`; the bare `name` only when apt says that exact version is not
  available), with the real
  `apt-get`, the whole run (planning included) within 15 minutes. A plain restart finds
  nothing missing and ends at once.
- The restore writes back only paths under `/etc/apt/` and `/usr/share/keyrings/` plus the key files a saved source names; any other saved path is ignored with a log line. If a previous run was cut off mid-install it first runs `dpkg --configure -a`. A recording lock older than a minute is treated as stale.
- The outcome is `/root/.rev4a/packages-status.json`:
  `{"at": <ms>, "state": "running"|"ok"|"partial"|"failed"|"nothing-to-do", "restored": [...],
  "versionChanged": [...], "failed": [{"name", "error"}]}`. `restored` lists every
  package installed again; `versionChanged` is the subset that came back in another
  version.

Rev4a shows the outcome (phase 2): the agent panel's SYSTEM PACKAGES section lists the recorded packages and the last restore, and the daemon records a `packages_failed` alert (System page, Recent alerts) when a restore ends `failed` or `partial`. Both are read-only (`cat` of the two files in `/root/.rev4a/`); the image is unchanged.

Tools installed any other way (`npm -g`, `pip`, a downloaded binary) are not recorded:
the agent keeps them under `/root/.local`, whose `bin` is on `PATH`. The rules the agent
reads are in `rev4a-rules/AGENTS.md`. Test: `bash scripts/test-rev4a-apt.sh`.

### Access

An agent's Control UI is reached on its published host port,
`http://<host>:<port>`, with the gateway token. The Agents page opens it with a
one-time link that also approves the browser; any other browser needs approval once
in the agent's Browser access section.

Rev4a sets no reverse-proxy labels. For HTTPS or a domain, put your own reverse
proxy in front of the published port.

### Creating an agent by hand

Use the creation wizard (`/agents/create`): it copies the template files, mounts
the shared volumes, writes the model and provider configuration and waits for the
gateway. A bare container, for testing the image only:

```bash
docker run -d \
  --name <id> \
  --network rev4a-network \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -v agent-<id>-data:/root \
  -l "AGENT_ID=<id>" \
  -e OPENCLAW_GATEWAY_TOKEN=<token> \
  -p <port>:3000 \
  openclaw-agent-base:<tag>
```

## Template directories

Each subdirectory (`atlas/`, `argus/`, `prometheus/`, `custom/`) holds the files
copied into a new agent's workspace. See
[docs/REV4A.md](../docs/REV4A.md#template-directories).
