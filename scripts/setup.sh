#!/usr/bin/env bash
# setup.sh — Olympus one-command setup
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Flame0510/olympus/main/scripts/setup.sh | bash
#
#   or clone the repo and run locally:
#     git clone https://github.com/Flame0510/olympus.git
#     cd olympus
#     sudo bash scripts/setup.sh
#
# What it does:
#   1. Pre-flight checks (OS, disk, RAM, internet)
#   2. Install Docker + Compose (if missing)
#   3. Deploy or detect Traefik reverse proxy
#   4. Clone, build, and start the Olympus dashboard
#
# The script is idempotent — run it multiple times safely.
# Existing config (.env, provider keys) is never overwritten.
set -euo pipefail

# Resolve the script directory, even when piped from curl
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  SCRIPT_DIR="$(pwd)"
fi

export OLYMPUS_ROOT="${OLYMPUS_ROOT:-/opt/olympus}"

# ------------------------------------------------------------------------------
# Source helpers (handle both local and piped execution)
if [[ -f "${SCRIPT_DIR}/setup/helpers.sh" ]]; then
  source "${SCRIPT_DIR}/setup/helpers.sh"
else
  # We're running from curl — download helpers to /tmp
  REPO_RAW="https://raw.githubusercontent.com/Flame0510/olympus/main/scripts"
  TMPDIR="$(mktemp -d)"
  trap "rm -rf $TMPDIR" EXIT

  log_info_no_source() { echo -e "\033[0;34m[INFO]\033[0m  $*"; }
  log_ok_no_source()   { echo -e "\033[0;32m[OK]\033[0m    $*"; }

  log_info_no_source "Downloading setup helpers..."
  curl -fsSL "${REPO_RAW}/setup/helpers.sh" -o "${TMPDIR}/helpers.sh"
  curl -fsSL "${REPO_RAW}/setup/docker.sh"   -o "${TMPDIR}/docker.sh"
  curl -fsSL "${REPO_RAW}/setup/traefik.sh"  -o "${TMPDIR}/traefik.sh"
  curl -fsSL "${REPO_RAW}/setup/olympus.sh"  -o "${TMPDIR}/olympus.sh"

  SCRIPT_DIR="${TMPDIR}"
  source "${TMPDIR}/helpers.sh"
fi

# ------------------------------------------------------------------------------
main() {
  echo ""
  echo "  ╔══════════════════════════════════════╗"
  echo "  ║       Olympus Setup v0.1.0            ║"
  echo "  ║  OpenClaw Agent Ecosystem Dashboard   ║"
  echo "  ╚══════════════════════════════════════╝"
  echo ""

  preflight

  # ---- 1. Docker ----
  source "${SCRIPT_DIR}/setup/docker.sh"
  setup_docker

  # ---- 2. Traefik ----
  source "${SCRIPT_DIR}/setup/traefik.sh"
  setup_traefik

  # ---- 3. Olympus ----
  source "${SCRIPT_DIR}/setup/olympus.sh"
  setup_olympus
}

main "$@"
