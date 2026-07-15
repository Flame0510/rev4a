#!/usr/bin/env bash
# docker.sh — install and configure Docker Engine + Compose plugin
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/helpers.sh"

is_docker_installed() {
  has_cmd docker && docker info &>/dev/null
}

is_compose_installed() {
  has_cmd docker && docker compose version &>/dev/null
}

is_user_in_docker_group() {
  groups "$USER" 2>/dev/null | grep -qw docker
}

install_docker() {
  if is_docker_installed; then
    log_ok "Docker is already installed ($(docker --version))"
    return 0
  fi

  log_info "Installing Docker Engine..."
  curl -fsSL https://get.docker.com | $SUDO sh

  if ! is_docker_installed; then
    die "Docker installation failed. Check the output above."
  fi

  log_ok "Docker installed ($(docker --version))"
}

install_compose() {
  if is_compose_installed; then
    log_ok "Docker Compose is already available ($(docker compose version))"
    return 0
  fi

  log_info "Installing Docker Compose plugin..."

  # Use the official convenience script (installs the plugin, not the standalone binary)
  local arch
  arch=$(uname -m)
  local compose_version="v2.27.0"

  local dl_url="https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-${arch}"
  if [[ "$arch" == "x86_64" ]]; then
    dl_url="https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-x86_64"
  elif [[ "$arch" == "aarch64" ]]; then
    dl_url="https://github.com/docker/compose/releases/download/${compose_version}/docker-compose-linux-aarch64"
  fi

  local cli_plugins_dir="${HOME}/.docker/cli-plugins"
  mkdir -p "$cli_plugins_dir"
  $SUDO curl -fsSL "$dl_url" -o /usr/local/lib/docker/cli-plugins/docker-compose 2>/dev/null || \
    $SUDO curl -fsSL "$dl_url" -o "$cli_plugins_dir/docker-compose"
  $SUDO chmod +x /usr/local/lib/docker/cli-plugins/docker-compose 2>/dev/null || \
    $SUDO chmod +x "$cli_plugins_dir/docker-compose"

  if ! is_compose_installed; then
    die "Compose plugin installation failed."
  fi
  log_ok "Docker Compose installed ($(docker compose version))"
}

add_user_to_docker_group() {
  if is_user_in_docker_group; then
    log_ok "User '$USER' is already in the docker group"
    return 0
  fi

  log_info "Adding user '$USER' to the docker group..."
  $SUDO usermod -aG docker "$USER"

  log_warn "You may need to log out and back in (or run 'newgrp docker') for group changes to take effect."
}

start_docker_service() {
  if systemctl is-active --quiet docker; then
    log_ok "Docker service is running"
  else
    log_info "Starting Docker service..."
    $SUDO systemctl enable --now docker
    log_ok "Docker service started"
  fi
}

# ------------------------------------------------------------------------------
setup_docker() {
  log_info "--- Docker setup ---"
  install_docker
  start_docker_service
  install_compose
  add_user_to_docker_group
  log_ok "Docker setup complete"
}
