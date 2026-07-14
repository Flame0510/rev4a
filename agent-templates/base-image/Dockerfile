# OpenClaw Agent Base Image
#
# Base image for agent containers in the Olympus ecosystem.
# Includes: Node, OpenClaw, gh CLI, Vercel CLI, entrypoint.
# Supabase/Trello: env-file based auth; Supabase CLI preinstalled for db/function operations.
#
# Traefik integration:
#   - Static enablement is baked into the image.
#   - Dynamic router/service labels are provided
#     at container creation time via `docker run -l ...`.
#   - See agent-templates/README.md for the full label set.
#
# Build:
#   docker build -t openclaw-agent-base:latest -f Dockerfile .
#
# Test:
#   docker run --rm openclaw-agent-base:latest openclaw --version
#
# Run with Traefik support:
#   docker run -d \
#     --name agent-<id> \
#     --network openclaw-core_default \
#     --restart unless-stopped \
#     -l "AGENT_ID=<id>" \
#     -l "traefik.enable=true" \
#     -l "traefik.http.routers.agent-<id>.entrypoints=websecure" \
#     -l "traefik.http.routers.agent-<id>.rule=Host(`<id>.<your-domain>`)" \
#     -l "traefik.http.routers.agent-<id>.tls.certresolver=letsencrypt" \
#     -l "traefik.http.services.agent-<id>.loadbalancer.server.port=3000" \
#     -e AGENT_ID=<id> \
#     openclaw-agent-base:latest

FROM node:24-bookworm-slim

LABEL description="OpenClaw Agent Base — Olympus multicontainer ecosystem"
LABEL maintainer="Olympus Agency"

# Traefik static labels — enable proxy support by default.
# Dynamic router/service labels must be provided at container creation.
LABEL traefik.enable="true"

# Avoid interactive prompts
ENV DEBIAN_FRONTEND=noninteractive
ENV NODE_ENV=production

# System dependencies + gh CLI
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    openssl \
    gpg \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       | gpg --dearmor -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# OpenClaw + Vercel CLI + Supabase CLI + Trello CLI
# Patch openclaw.json to allow Control UI from any Host — token auth is the real guard
RUN npm install -g openclaw vercel supabase trello-cli \
    && openclaw plugins install npm:@openclaw/deepseek-provider \
    && echo '{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}}}' \
       | openclaw config patch --stdin

# Default config directory
RUN mkdir -p /data/.openclaw

# Standard entrypoint
COPY entrypoint.sh /agent-entrypoint.sh
RUN chmod +x /agent-entrypoint.sh

WORKDIR /data
EXPOSE 3000

ENTRYPOINT ["/agent-entrypoint.sh"]
CMD ["openclaw", "gateway", "--bind", "lan", "--port", "3000"]
