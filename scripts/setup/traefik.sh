#!/usr/bin/env bash
# traefik.sh — deploy or detect an existing Traefik reverse proxy
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

TRAEFIK_DIR="${OLYMPUS_TRAEFIK}"
TRAEFIK_NETWORK="olympus-traefik"
TRAEFIK_HTTP_PORT="${TRAEFIK_HTTP_PORT:-80}"
TRAEFIK_HTTPS_PORT="${TRAEFIK_HTTPS_PORT:-443}"

# ------------------------------------------------------------------------------
# Check if any Traefik container is already running on this host
detect_existing_traefik() {
  local count
  count=$($SUDO docker ps --filter "name=traefik" --format '{{.Names}}' 2>/dev/null | wc -l)
  if [[ $count -gt 0 ]]; then
    log_ok "Existing Traefik container detected: $($SUDO docker ps --filter 'name=traefik' --format '{{.Names}}' | head -1)"
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------------------
# Check if ports 80/443 are already bound (by anything)
ports_in_use() {
  if ss -tlnp | grep -qE ":${TRAEFIK_HTTP_PORT} |:${TRAEFIK_HTTPS_PORT} "; then
    log_warn "Ports ${TRAEFIK_HTTP_PORT}/${TRAEFIK_HTTPS_PORT} are already in use"
    ss -tlnp | grep -E ":${TRAEFIK_HTTP_PORT} |:${TRAEFIK_HTTPS_PORT} "
    return 0
  fi
  return 1
}

# ------------------------------------------------------------------------------
# Create the Traefik Docker network (isolated from other Compose networks)
create_traefik_network() {
  if $SUDO docker network inspect "$TRAEFIK_NETWORK" &>/dev/null; then
    log_ok "Docker network '$TRAEFIK_NETWORK' already exists"
    return 0
  fi
  log_info "Creating Docker network '$TRAEFIK_NETWORK'..."
  $SUDO docker network create "$TRAEFIK_NETWORK"
  log_ok "Network '$TRAEFIK_NETWORK' created"
}

# ------------------------------------------------------------------------------
# Deploy the Olympus Traefik stack
deploy_traefik() {
  if detect_existing_traefik; then
    log_info "Skipping Traefik deployment — existing instance will be used."
    log_info "Olympus will serve on port 3740. Configure your existing Traefik"
    log_info "to route to http://127.0.0.1:3740 if you want domain/HTTPS access."
    return 0
  fi

  log_info "No existing Traefik found. Deploying a dedicated Traefik instance..."

  ensure_dir "$TRAEFIK_DIR"
  ensure_dir "${TRAEFIK_DIR}/dynamic"
  ensure_dir "${TRAEFIK_DIR}/certs"

  # Copy Compose + config files from the repo
  local repo_traefik_dir="${SCRIPT_DIR}/../docker/traefik"
  if [[ -d "$repo_traefik_dir" ]]; then
    cp "${repo_traefik_dir}/docker-compose.yml" "${TRAEFIK_DIR}/"
    cp "${repo_traefik_dir}/traefik.yml" "${TRAEFIK_DIR}/"
  fi

  # Replace placeholder ACME email in traefik.yml
  local acme_email="${TRAEFIK_ACME_EMAIL:-admin@example.com}"
  if [[ -f "${TRAEFIK_DIR}/traefik.yml" ]]; then
    $SUDO sed -i "s/admin@example\.com/${acme_email}/" "${TRAEFIK_DIR}/traefik.yml"
    log_info "ACME email set to: ${acme_email}"
    if [[ "$acme_email" == "admin@example.com" ]]; then
      log_warn "Using default ACME email. Set TRAEFIK_ACME_EMAIL env var for Let's Encrypt certificates."
      log_warn "  Example: TRAEFIK_ACME_EMAIL=your@email.com sudo -E bash scripts/setup.sh"
    fi
  fi

  # Create empty dynamic config (placeholders for runtime routes)
  if [[ ! -f "${TRAEFIK_DIR}/dynamic/olympus.yml" ]]; then
    cat > "${TRAEFIK_DIR}/dynamic/olympus.yml" << 'YML'
# Olympus dashboard — add your domain below and the router will pick it up.
# When no domain is set, Olympus is reachable at http://<ip>:3740 directly.
#
# Example with domain:
#   http:
#     routers:
#       olympus-dashboard:
#         entryPoints: [websecure]
#         rule: "Host(`olympus.yourdomain.com`)"
#         service: olympus
#         tls:
#           certResolver: letsencrypt
#     services:
#       olympus:
#         loadBalancer:
#           servers:
#             - url: "http://127.0.0.1:3740"
YML
    log_info "Created ${TRAEFIK_DIR}/dynamic/olympus.yml"
  fi

  # Create the network before bringing up Traefik
  create_traefik_network

  if ports_in_use; then
    if confirm "Ports 80/443 are in use. Do you want to stop the conflicting service?" "n"; then
      log_warn "Stopping conflicting services — you will need to restart them manually later."
      # Try to identify and stop whatever is on 80/443
      local pid_80 pid_443
      pid_80=$(ss -tlnp | grep ":80 " | grep -oP 'pid=\K\d+' | head -1 || true)
      pid_443=$(ss -tlnp | grep ":443 " | grep -oP 'pid=\K\d+' | head -1 || true)
      [[ -n "$pid_80" ]] && $SUDO kill "$pid_80" 2>/dev/null || true
      [[ -n "$pid_443" ]] && $SUDO kill "$pid_443" 2>/dev/null || true
      sleep 2
    else
      log_warn "Skipping Traefik deployment — ports 80/443 are not free."
      return 0
    fi
  fi

  log_info "Starting Traefik..."
  cd "$TRAEFIK_DIR"
  $SUDO docker compose up -d

  # Wait for Traefik to be healthy
  sleep 3
  if $SUDO docker ps --filter "name=traefik-olympus" --format '{{.Names}}' 2>/dev/null | grep -q .; then
    log_ok "Traefik is running (container: traefik-olympus)"
    log_info "Traefik dashboard: http://localhost:8080 (internal only)"
  else
    log_error "Traefik failed to start. Check logs: docker compose -f ${TRAEFIK_DIR}/docker-compose.yml logs"
    return 1
  fi
}

# ------------------------------------------------------------------------------
# Test that the Olympus backend is reachable from Traefik's network
verify_olympus_reachable() {
  log_info "Testing local Olympus connectivity..."
  if curl -sf --max-time 3 http://127.0.0.1:3740/api/health 2>/dev/null | grep -q .; then
    log_ok "Olympus is reachable at http://127.0.0.1:3740"
  else
    log_warn "Olympus is NOT reachable at http://127.0.0.1:3740"
    log_warn "Traefik won't be able to proxy to Olympus until the service is started."
    log_warn "Run the olympus setup step first, then restart Traefik."
  fi
}

# ------------------------------------------------------------------------------
setup_traefik() {
  log_info "--- Traefik setup ---"
  deploy_traefik
  verify_olympus_reachable
  log_ok "Traefik setup complete"
}
