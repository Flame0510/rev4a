#!/bin/bash
# Olympus Agent Spawner
# 
# Creates a new agent container from the openclaw-agent-base image.
# Supports both interactive CLI and non-interactive API-driven spawn.
#
# Usage (CLI):
#   bash scripts/spawn-agent.sh <agent_id>
#
# Usage (API/non-interactive):
#   OLYMPUS_SKIP_TRAEFIK=true \
#   OLYMPUS_NETWORK=openclaw-core_default \
#   OLYMPUS_GATEWAY_TOKEN=*** \
#   OLYMPUS_MODEL_PRIMARY=olympus/deepseek-v4-pro \
#   bash scripts/spawn-agent.sh --non-interactive <agent_id>
#
# Environment variables:
#   OLYMPUS_NETWORK        — Docker network (default: olympus-net)
#   OLYMPUS_IMAGE          — Agent image (default: openclaw-agent-base:latest)
#   OLYMPUS_TRAEFIK_DOMAIN — Base domain for Traefik (default: example.com)
#   OLYMPUS_SKIP_TRAEFIK   — Skip Traefik labels if true
#   OLYMPUS_GATEWAY_TOKEN  — Gateway token (required for non-interactive)
#   OLYMPUS_MODEL_PRIMARY  — Primary model (optional)
#   OLYMPUS_HOST_PORT      — Host port to publish (optional, default: none)

set -e

NON_INTERACTIVE=false
if [[ "${1:-}" == "--non-interactive" ]]; then
  NON_INTERACTIVE=true
  shift
fi

AGENT_ID="${1:-}"
if [ -z "$AGENT_ID" ]; then
  echo "Usage: $0 [--non-interactive] <agent_id>"
  echo ""
  echo "Examples:"
  echo "  $0 argus"
  echo "  $0 --non-interactive atlas"
  exit 1
fi

# Config
NETWORK="${OLYMPUS_NETWORK:-olympus-net}"
IMAGE="${OLYMPUS_IMAGE:-openclaw-agent-base:latest}"
TRAEFIK_DOMAIN="${OLYMPUS_TRAEFIK_DOMAIN:-example.com}"
HOST_DATA_DIR="/docker/agent-${AGENT_ID}"
CONTAINER_NAME="agent-${AGENT_ID}"
SHARED_SKILLS="/docker/shared-skills"
SHARED_REPOS="/docker/shared-repos"

# Validate non-interactive requirements
if $NON_INTERACTIVE; then
  if [ -z "${OLYMPUS_GATEWAY_TOKEN:-}" ]; then
    echo "[spawn] ERROR: OLYMPUS_GATEWAY_TOKEN required in non-interactive mode"
    exit 1
  fi
fi

# Shared volumes: created by setup script, verified here
for vol in "$SHARED_SKILLS" "$SHARED_REPOS"; do
  if [[ ! -d "$vol" ]]; then
    echo "[spawn] WARNING: $vol not found — run scripts/setup/olympus.sh first"
    mkdir -p "$vol"
    if id -u 1000 &>/dev/null; then
      chown 1000:1000 "$vol"
    fi
    chmod 2775 "$vol"
  fi
done

# Check if the container already exists
if docker ps -a --format '{{.Names}}' | grep -q "^${CONTAINER_NAME}$"; then
  if $NON_INTERACTIVE; then
    echo "[spawn] Removing existing container '$CONTAINER_NAME'..."
    docker rm -f "$CONTAINER_NAME"
  else
    echo "[spawn] Container '$CONTAINER_NAME' already exists."
    read -p "Remove and recreate? [y/N] " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      docker rm -f "$CONTAINER_NAME"
    else
      echo "[spawn] Aborted."
      exit 0
    fi
  fi
fi

# Build docker run arguments
DOCKER_ARGS=(
  -d
  --name "$CONTAINER_NAME"
  --network "$NETWORK"
  --restart unless-stopped
  --cpus="2"
  --memory="4g"
  -v "${HOST_DATA_DIR}:/data:rw"
  -v "${SHARED_SKILLS}:/data/.openclaw/shared-skills:ro"
  -v "${SHARED_REPOS}:/data/repos:rw"
  -e "AGENT_ID=${AGENT_ID}"
  -e "TZ=Europe/Rome"
)

# Gateway token
if [ -n "${OLYMPUS_GATEWAY_TOKEN:-}" ]; then
  DOCKER_ARGS+=(-e "OPENCLAW_GATEWAY_TOKEN=${OLYMPUS_GATEWAY_TOKEN}")
fi

# Primary model
if [ -n "${OLYMPUS_MODEL_PRIMARY:-}" ]; then
  DOCKER_ARGS+=(-e "OPENCLAW_MODEL_PRIMARY=${OLYMPUS_MODEL_PRIMARY}")
fi

# Host port (optional)
if [ -n "${OLYMPUS_HOST_PORT:-}" ]; then
  DOCKER_ARGS+=(-p "${OLYMPUS_HOST_PORT}:3000")
fi

# Traefik labels
if [ "${OLYMPUS_SKIP_TRAEFIK}" != "true" ]; then
  DOCKER_ARGS+=(
    -l "AGENT_ID=${AGENT_ID}"
    -l "traefik.enable=true"
    -l "traefik.http.routers.${CONTAINER_NAME}.entrypoints=websecure"
    -l "traefik.http.routers.${CONTAINER_NAME}.rule=Host(\`${AGENT_ID}.${TRAEFIK_DOMAIN}\`)"
    -l "traefik.http.routers.${CONTAINER_NAME}.tls.certresolver=letsencrypt"
    -l "traefik.http.services.${CONTAINER_NAME}.loadbalancer.server.port=3000"
  )
  echo "[spawn] Traefik: https://${AGENT_ID}.${TRAEFIK_DOMAIN}"
else
  DOCKER_ARGS+=(-l "AGENT_ID=${AGENT_ID}")
fi

# Spawn
echo "[spawn] Starting container '$CONTAINER_NAME'..."
docker run "${DOCKER_ARGS[@]}" "$IMAGE"

CID=$(docker ps -q --filter "name=${CONTAINER_NAME}")
echo "[spawn] Done. Container: ${CID}"


if [ "${OLYMPUS_SKIP_TRAEFIK}" != "true" ]; then
  echo "[spawn] URL: https://${AGENT_ID}.${TRAEFIK_DOMAIN}"
fi

echo ""
echo "[spawn] Logs: docker logs -f $CONTAINER_NAME"
echo "[spawn] Stop: docker stop $CONTAINER_NAME && docker rm $CONTAINER_NAME"
