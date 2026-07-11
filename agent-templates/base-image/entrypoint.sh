#!/bin/bash
# Agent Container Entrypoint
#
# Resolves the gateway auth token and starts the OpenClaw gateway.
# controlUi settings (dangerouslyUseHostHeaderOrigin, dangerouslyDisableDeviceAuth)
# are baked into openclaw.json during the image build — this script does NOT touch it.

set -e

# Determine auth token: /root/.agent-token file > OPENCLAW_GATEWAY_TOKEN env > random
AGENT_TOKEN=
if [ -f /root/.agent-token ]; then
  AGENT_TOKEN=$(head -1 /root/.agent-token | tr -d '[:space:]')
elif [ -n "$OPENCLAW_GATEWAY_TOKEN" ]; then
  AGENT_TOKEN="$OPENCLAW_GATEWAY_TOKEN"
fi

if [ -z "$AGENT_TOKEN" ]; then
  AGENT_TOKEN=$(openssl rand -hex 16 2>/dev/null || echo "agent-$(date +%s)-$$-${RANDOM}")
fi

echo "[entrypoint] Starting gateway with auth token"
exec openclaw gateway --bind lan --port 3000 --auth token --token "${AGENT_TOKEN}" --allow-unconfigured
