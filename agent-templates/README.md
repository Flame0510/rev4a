# Agent Templates

## Base Image: `openclaw-agent-base`

The base image for all agent containers in the Rev4a ecosystem.

### Traefik Integration

The image includes the minimum static labels required by Traefik:
- `traefik.enable=true`

Dynamic labels (router rule, hostname, certresolver) must be passed at
`docker run` time. The Rev4a agent creation wizard (`/agents/create`)
generates them automatically.

### Required Traefik Labels

When creating an agent manually with `docker run`, add these labels:

```bash
docker run -d \
  --name agent-<id> \
  --network openclaw-core_default \
  --restart unless-stopped \
  -l "AGENT_ID=<id>" \
  -l "traefik.enable=true" \
  -l "traefik.http.routers.agent-<id>.entrypoints=websecure" \
  -l "traefik.http.routers.agent-<id>.rule=Host(\`<id>.<your-domain>\`)" \
  -l "traefik.http.routers.agent-<id>.tls.certresolver=letsencrypt" \
  -l "traefik.http.services.agent-<id>.loadbalancer.server.port=3000" \
  -e AGENT_ID=<id> \
  openclaw-agent-base:latest
```

After creation:
- The agent is reachable at `https://<agent_id>.<your-domain>`
- The Rev4a Agents page shows it with the Traefik link and a copyable token
