# Agent Templates

## Base image: `openclaw-agent-base`

The image every agent container runs, built from
[`base-image/Dockerfile`](base-image/Dockerfile).

It contains Node 24, OpenClaw, `gh`, `vercel`, `trello`, `supabase`, the plugins
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
