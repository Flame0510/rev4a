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

# Run OpenClaw safe migrations only when the version changed since last boot
# (i.e. after the image was rebuilt to a newer OpenClaw). This aligns the
# persistent volume's state/config to the binary shipped in the image.
# --non-interactive applies only safe migrations and SKIPS restart/service
# actions, so it never restarts the gateway from under us. Runs BEFORE the
# gateway starts, while state is at rest. Best-effort: never blocks boot.
CUR_VER=$(openclaw --version 2>/dev/null || true)
PREV_VER=$(cat /root/.openclaw/.last-version 2>/dev/null || true)
if [ -n "$CUR_VER" ] && [ "$CUR_VER" != "$PREV_VER" ]; then
  echo "[entrypoint] OpenClaw version changed ('${PREV_VER}' -> '${CUR_VER}') — running safe migrations"
  openclaw doctor --non-interactive || echo "[entrypoint] doctor returned non-zero (ignored)"
  mkdir -p /root/.openclaw && printf '%s' "$CUR_VER" > /root/.openclaw/.last-version
fi

echo "[entrypoint] Starting gateway with auth token"
exec openclaw gateway --bind lan --port 3000 --auth token --token "${AGENT_TOKEN}" --allow-unconfigured
