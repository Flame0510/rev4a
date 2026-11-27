# Agent Templates

> **Last updated:** 2026-11-18

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
- `rev4a-gateway-auth` decides how the entrypoint hands the agent token to the gateway.
  The token goes in `OPENCLAW_GATEWAY_TOKEN` and the gateway starts without `--token`, so
  it is no longer in process listings (`ps`, `docker top`) on the host or in the container;
  processes in the container run as root and can still read the environment and the token
  file, and the gateway's child processes inherit the live token. Agents on 2026.9.3 and on
  a 2026.9.9 image built before 384bd8e still use `--token` until recreated or updated. When `openclaw.json` sets its own `gateway.auth` (token,
  password or a non-token mode; the config beats the environment) or cannot be read, the
  entrypoint keeps `--token` and logs it. From the 384bd8e build on the image is built
  natively for amd64 and arm64 and published as one multi-arch tag (see `CONTRIBUTING.md`);
  2026.9.3 (28cf675) and older tags are amd64 only and run emulated on ARM hosts, and a
  retag of a pre-multi-arch `:latest` copies only amd64. On a Mac the native image arrives
  after the new 2026.9.9 build is downloaded (NEW BUILD) and the agent is recreated or updated.
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
reads are in `rev4a-rules/AGENTS.md`, which also tells it that credentials are provided by OpenClaw
when switched on in Rev4a — environment variables plus the enabled skill, OpenClaw's managed
identity for GitHub, the CLI's own login files for Vercel — and never come from TOOLS.md. Test: `bash scripts/test-rev4a-apt.sh`.

### Access

An agent's Control UI is reached on its published host port,
`http://<host>:<port>`, with the gateway token. The Agents page opens it with a
one-time link that also approves the browser; any other browser needs approval once
in the agent's Browser access section.

For HTTPS, [Domain mode](../CONNECT.md#caddy-domain-mode-1300) manages a dedicated hostname for
each agent through Caddy. You can also configure your own reverse proxy to the published port.

### Creating an agent by hand

The creation wizard (`/agents/create`) copies the template files, mounts the
shared volumes, waits for the Gateway and applies provider configuration when
the Gateway key and catalogue are available. Choose an offered model in Create
or deploy without one. For an agent without a model, **Set up the model** chooses
`gpt-6.1-sol` for ChatGPT or the first Sonnet for Claude when available, then
falls back to the first model from that provider. The agent panel's **Model**
section lets you set the primary and fallbacks manually.

To test the image in a bare container, run the following.

```bash
export OPENCLAW_GATEWAY_TOKEN=<token>   # docker reads the value from the environment
docker run -d --init \
  --name <id> \
  --network rev4a-network \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -v agent-<id>-data:/root \
  -l "AGENT_ID=<id>" \
  -e OPENCLAW_GATEWAY_TOKEN \
  -p <port>:3000 \
  openclaw-agent-base:<tag>
```

## Template directories

Each subdirectory (`atlas/`, `argus/`, `prometheus/`, `custom/`) holds the files
copied into a new agent's workspace. See
[docs/REV4A.md](../docs/REV4A.md#template-directories).
