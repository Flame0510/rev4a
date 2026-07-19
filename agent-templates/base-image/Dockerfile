# OpenClaw Agent Base Image
#
# Base image for agent containers in the Olympus ecosystem.
# Includes: Node, OpenClaw, gh CLI, Vercel CLI, Trello CLI, entrypoint.
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

# Agent containers route model requests through Olympus provider proxy
RUN npm install -g openclaw@2026.7.1 vercel trello-cli \
# Supabase CLI — installed via official GitHub release (npm global no longer supported on Linux)
# Pinned to v2.109.1. Bump the version here to update.
    && curl -fsSL https://github.com/supabase/cli/releases/download/v2.109.1/supabase_linux_amd64.tar.gz -o /tmp/supabase.tar.gz \
    && tar xzf /tmp/supabase.tar.gz -C /usr/local/bin supabase \
    && chmod +x /usr/local/bin/supabase \
    && rm /tmp/supabase.tar.gz \
    && echo '{"gateway":{"mode":"local","controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true,"dangerouslyDisableDeviceAuth":true}}}' \
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

