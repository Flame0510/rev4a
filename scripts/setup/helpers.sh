#!/usr/bin/env bash
# helpers.sh — common utilities for the Olympus setup scripts
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

OLYMPUS_ROOT="/opt/olympus"
OLYMPUS_APP="${OLYMPUS_ROOT}/app"
OLYMPUS_DATA="${OLYMPUS_ROOT}/data"
OLYMPUS_TRAEFIK="${OLYMPUS_ROOT}/traefik"

# ------------------------------------------------------------------------------
log_info()  { echo -e "${BLUE}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ------------------------------------------------------------------------------
# Abort with a message
die() {
  log_error "$*"
  exit 1
}

# ------------------------------------------------------------------------------
# Check if running as root (or sudo), warn if not
check_root() {
  if [[ $EUID -ne 0 ]]; then
    log_warn "Not running as root. Docker/systemd commands may need sudo."
    log_warn "Re-run with: sudo bash scripts/setup.sh"
    SUDO="sudo"
  else
    SUDO=""
  fi
}

# ------------------------------------------------------------------------------
# Check minimum OS (Ubuntu 20.04+ / Debian 11+)
check_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    case "$ID" in
      ubuntu|debian) ;;
      *)
        log_warn "Unsupported OS: $ID. Olympus is tested on Ubuntu/Debian."
        log_warn "The script may still work, but proceed at your own risk."
        ;;
    esac
  else
    log_warn "Cannot detect OS. Proceeding anyway."
  fi
}

# ------------------------------------------------------------------------------
# Check minimum disk space (default 5 GB)
check_disk() {
  local min_gb="${1:-5}"
  local avail_kb
  avail_kb=$(df --output=avail / | tail -1 | tr -d ' ')
  local avail_gb=$((avail_kb / 1024 / 1024))
  if [[ $avail_gb -lt $min_gb ]]; then
    die "Insufficient disk space: ${avail_gb} GB available, need at least ${min_gb} GB."
  fi
  log_ok "Disk space: ${avail_gb} GB available"
}

# ------------------------------------------------------------------------------
# Check minimum RAM (default 2 GB)
check_ram() {
  local min_gb="${1:-2}"
  local total_kb
  total_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  local total_gb=$((total_kb / 1024 / 1024))
  if [[ $total_gb -lt $min_gb ]]; then
    die "Insufficient RAM: ${total_gb} GB, need at least ${min_gb} GB."
  fi
  log_ok "RAM: ${total_gb} GB"
}

# ------------------------------------------------------------------------------
# Check internet connectivity
check_internet() {
  if ! ping -c 1 -W 3 8.8.8.8 &>/dev/null; then
    die "No internet connectivity. The setup script needs to download packages."
  fi
  log_ok "Internet connectivity OK"
}

# ------------------------------------------------------------------------------
# Run all pre-flight checks
preflight() {
  log_info "Running pre-flight checks..."
  check_root
  check_os
  check_disk 5
  check_ram 2
  check_internet
  log_ok "Pre-flight checks passed"
}

# ------------------------------------------------------------------------------
# Create a directory if it doesn't exist
ensure_dir() {
  local dir="$1"
  if [[ ! -d "$dir" ]]; then
    $SUDO mkdir -p "$dir"
    log_info "Created $dir"
  fi
}

# ------------------------------------------------------------------------------
# Check if a command exists
has_cmd() {
  command -v "$1" &>/dev/null
}

# ------------------------------------------------------------------------------
# Generate a random string (used for passwords/secrets)
random_string() {
  local length="${1:-32}"
  openssl rand -base64 "$length" | tr -dc 'a-zA-Z0-9' | head -c "$length"
}

# ------------------------------------------------------------------------------
# Ask a yes/no question (default yes)
confirm() {
  local prompt="$1"
  local default="${2:-y}"
  local yn
  if [[ "$default" == "y" ]]; then
    read -r -p "${prompt} [Y/n] " yn
    [[ "$yn" != "n" && "$yn" != "N" ]]
  else
    read -r -p "${prompt} [y/N] " yn
    [[ "$yn" == "y" || "$yn" == "Y" ]]
  fi
}
