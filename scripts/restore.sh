#!/usr/bin/env bash
# restore.sh — Restore Olympus data from a backup archive
#
# Usage:
#   sudo bash scripts/restore.sh backups/olympus-backup-20260724-120000.tar.gz
#
# The script restores:
#   - data/*.db
#   - data/provider-keys.json
#   - data/agents-token.json
#   - models.config.json
#   - .env
#
# Existing files are backed up to a .pre-restore directory before overwriting.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLYMPUS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: sudo bash scripts/restore.sh <backup-archive.tar.gz>"
  echo ""
  echo "Available backups:"
  if [[ -d "${OLYMPUS_ROOT}/backups" ]]; then
    ls -lh "${OLYMPUS_ROOT}/backups/"*.tar.gz 2>/dev/null || echo "  (none)"
  else
    echo "  (no backups directory)"
  fi
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: Archive not found: $ARCHIVE"
  exit 1
fi

echo "Restoring Olympus from: $ARCHIVE"
echo ""

# Create pre-restore backup of current state
PRE_DIR="${OLYMPUS_ROOT}/backups/.pre-restore-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$PRE_DIR"

echo "Saving current state to: $PRE_DIR"
cd "$OLYMPUS_ROOT"
for f in data/*.db data/*.db-shm data/*.db-wal data/provider-keys.json data/agents-token.json models.config.json .env; do
  if [[ -f "$f" ]]; then
    cp --parents "$f" "$PRE_DIR/" 2>/dev/null || true
  fi
done

# Stop Olympus services before restore
if systemctl is-active --quiet olympus.target 2>/dev/null; then
  echo "Stopping Olympus services..."
  sudo systemctl stop olympus.target
  echo "Services stopped."
fi

# Extract the archive
echo "Extracting backup..."
tar -xzf "$ARCHIVE" -C "$OLYMPUS_ROOT"

# Fix permissions
chmod 600 "${OLYMPUS_ROOT}/.env" 2>/dev/null || true
chmod 600 "${OLYMPUS_ROOT}/data/provider-keys.json" 2>/dev/null || true
chmod 600 "${OLYMPUS_ROOT}/data/agents-token.json" 2>/dev/null || true

echo ""
echo "=============================================="
echo "  Restore complete!"
echo "=============================================="
echo ""
echo "  Previous state saved to: ${PRE_DIR}"
echo ""
echo "  To restart Olympus:"
echo "    sudo systemctl start olympus.target"
echo ""
echo "  If something went wrong, restore previous state from:"
echo "    ${PRE_DIR}"
echo "=============================================="
