#!/bin/bash
# Agent Container Entrypoint
#
# Writes only the controlUi.allowedOrigins config block on first boot.
# Everything else (gateway.mode, models, providers, agents) is handled
# by OpenClaw defaults + external sync from Olympus API.
#
# External sync/API:
#   - syncAgent + waitForContainerReady (create/route.ts)
#   - PUT /api/gateway/agent
#   - PUT /api/gateway/provider

set -e

mkdir -p /root/.openclaw
CONFIG_FILE="/root/.openclaw/openclaw.json"

# Determine auth token: /root/.agent-token file > OPENCLAW_GATEWAY_TOKEN env > local random
AGENT_TOKEN=
if [ -f /root/.agent-token ]; then
  AGENT_TOKEN=$(head -1 /root/.agent-token | tr -d '[:space:]')
elif [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  AGENT_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
fi

if [ -z "$AGENT_TOKEN" ]; then
  AGENT_TOKEN=$(openssl rand -hex 16 2>/dev/null || echo "agent-$(date +%s)-$$-${RANDOM}")
fi

# On first boot (no config exists), seed controlUi.allowedOrigins so the
# browser Control UI works from Olympus and the agent's Traefik hostname.
# This is the ONLY section we write — OpenClaw fills in the rest.
if [ ! -f "$CONFIG_FILE" ]; then
  ALLOWED='"https://olympus.example.com"'
  if [ -n "$AGENT_HOSTNAME" ]; then
    ALLOWED="${ALLOWED}, \"https://${AGENT_HOSTNAME}\""
  fi
  echo "[entrypoint] Seeding allowedOrigins: [${ALLOWED}]"
  cat > "$CONFIG_FILE" << JSONEOF
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": [${ALLOWED}],
      "dangerouslyDisableDeviceAuth": true
    }
  }
}
JSONEOF
  echo "[entrypoint] Config seeded"
fi

echo "[entrypoint] Starting gateway with auth token"
exec openclaw gateway --bind lan --port 3000 --auth token --token "${AGENT_TOKEN}" --allow-unconfigured
