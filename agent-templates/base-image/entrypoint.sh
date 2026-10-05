#!/bin/bash
# Agent Container Entrypoint
#
# Resolves the gateway auth token, applies OpenClaw's migrations after a version
# change, and starts the OpenClaw gateway. The gateway settings baked in at build
# time (gateway.mode, controlUi Host-header origin fallback) live in openclaw.json;
# this script does not edit that file.

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

# Apply OpenClaw's migrations when the version changed since the last boot: after
# the image moved to a newer OpenClaw, or on a new volume. Runs before the gateway
# starts, while state is at rest.
#
# `--fix` is required. From 2026.9.x the agent database schema is migrated only by
# `doctor --fix` with the gateway stopped; the gateway refuses the old schema rather
# than migrating it. `--non-interactive` applies the supported migrations and skips
# restart and service actions, so it never restarts the gateway from under us.
#
# The version is recorded only after a successful run, so a failed migration is
# retried on the next boot instead of being skipped for good. A failure does not
# block boot: the gateway starts and reports the problem itself.
CUR_VER=$(openclaw --version 2>/dev/null || true)
PREV_VER=$(cat /root/.openclaw/.last-version 2>/dev/null || true)
if [ -n "$CUR_VER" ] && [ "$CUR_VER" != "$PREV_VER" ]; then
  echo "[entrypoint] OpenClaw version changed ('${PREV_VER}' -> '${CUR_VER}') — running migrations"
  if openclaw doctor --fix --non-interactive; then
    mkdir -p /root/.openclaw && printf '%s' "$CUR_VER" > /root/.openclaw/.last-version
  else
    echo "[entrypoint] doctor --fix failed; migrations will be retried on the next boot"
  fi
fi

# Image defaults, applied before the gateway starts so none of them needs a restart.
# Each is written only when missing, so an explicit choice survives every boot and
# recreate:
#   - plugins.load.paths includes the plugins shipped under /opt/openclaw-plugins
#   - tools.web.search.provider is "duckduckgo" when no provider is set
#   - agents.defaults.heartbeat.every is "0m" when unset: every heartbeat tick is a
#     model-calling turn, so the recurring cadence is opt-in
#   - agents.defaults.compaction.maxActiveTranscriptBytes is "20mb" when unset: a run
#     compacts before the model-visible transcript grows past it, so a long-lived
#     session cannot keep inflating memory and cost
#   - agents.defaults.contextPruning.mode is "cache-ttl" when unset: old tool results
#     are trimmed from the in-memory context (1h TTL keeps prompt-cache prefixes stable)
#
# The config is read with one node process and written only through
# `openclaw config patch`, which validates. The plugin path goes in first: the
# provider is refused at validation unless its plugin is already discoverable.
# Nothing here blocks boot.
DDG_PLUGIN_DIR=/opt/openclaw-plugins/node_modules/@openclaw/duckduckgo-plugin
DEFAULTS=$(DDG_PLUGIN_DIR="$DDG_PLUGIN_DIR" node -e '
  const fs = require("fs");
  const dir = process.env.DDG_PLUGIN_DIR;
  let cfg = {};
  try {
    const file = "/root/.openclaw/openclaw.json";
    if (fs.existsSync(file)) cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    console.log("unreadable");
    process.exit(0);
  }
  const hasPlugin = fs.existsSync(dir + "/openclaw.plugin.json");
  const paths = Array.isArray(cfg.plugins?.load?.paths) ? cfg.plugins.load.paths : [];
  const out = {};
  if (hasPlugin && !paths.includes(dir)) out.paths = { plugins: { load: { paths: [...paths, dir] } } };
  if (hasPlugin && !cfg.tools?.web?.search?.provider) out.provider = { tools: { web: { search: { provider: "duckduckgo" } } } };
  if (cfg.agents?.defaults?.heartbeat?.every === undefined) out.heartbeat = { agents: { defaults: { heartbeat: { every: "0m" } } } };
  if (cfg.agents?.defaults?.compaction?.maxActiveTranscriptBytes === undefined) out.compaction = { agents: { defaults: { compaction: { maxActiveTranscriptBytes: "20mb" } } } };
  if (cfg.agents?.defaults?.contextPruning?.mode === undefined) out.contextPruning = { agents: { defaults: { contextPruning: { mode: "cache-ttl", ttl: "1h" } } } };
  for (const [name, patch] of Object.entries(out)) console.log(name + " " + JSON.stringify(patch));
' 2>/dev/null || echo "unreadable")

if [ "$DEFAULTS" = "unreadable" ]; then
  echo "[entrypoint] openclaw.json could not be read as JSON; image defaults not applied"
elif [ -n "$DEFAULTS" ]; then
  while read -r name patch; do
    if printf '%s' "$patch" | openclaw config patch --stdin >/dev/null 2>&1; then
      echo "[entrypoint] image default applied: $name"
    else
      echo "[entrypoint] image default not applied: $name (config patch refused it)"
    fi
  done <<< "$DEFAULTS"
fi

echo "[entrypoint] Starting gateway with auth token"
exec openclaw gateway --bind lan --port 3000 --auth token --token "${AGENT_TOKEN}" --allow-unconfigured
