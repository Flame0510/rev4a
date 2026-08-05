#!/usr/bin/env bash
# restore.sh — Restore Rev4a data from a backup archive
#
# Usage:
#   sudo bash scripts/restore.sh backups/rev4a-backup-20260724-120000.tar.gz
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
REV4A_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: sudo bash scripts/restore.sh <backup-archive.tar.gz>"
  echo ""
  echo "Available backups:"
  if [[ -d "${REV4A_ROOT}/backups" ]]; then
    ls -lh "${REV4A_ROOT}/backups/"*.tar.gz 2>/dev/null || echo "  (none)"
  else
    echo "  (no backups directory)"
  fi
  exit 1
fi

if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: Archive not found: $ARCHIVE"
  exit 1
fi

echo "Restoring Rev4a from: $ARCHIVE"
echo ""

# Create pre-restore backup of current state
PRE_DIR="${REV4A_ROOT}/backups/.pre-restore-$(date -u +%Y%m%d-%H%M%S)"
mkdir -p "$PRE_DIR"

echo "Saving current state to: $PRE_DIR"
cd "$REV4A_ROOT"
for f in data/*.db data/*.db-shm data/*.db-wal data/provider-keys.json data/agents-token.json models.config.json .env; do
  if [[ -f "$f" ]]; then
    cp --parents "$f" "$PRE_DIR/" 2>/dev/null || true
  fi
done

# Stop Rev4a services before restore
if systemctl is-active --quiet rev4a.service 2>/dev/null; then
  echo "Stopping Rev4a services..."
  sudo systemctl stop rev4a.service
  echo "Services stopped."
fi

# Extract the archive
echo "Extracting backup..."
tar -xzf "$ARCHIVE" -C "$REV4A_ROOT"

# Fix permissions
chmod 600 "${REV4A_ROOT}/.env" 2>/dev/null || true
chmod 600 "${REV4A_ROOT}/data/provider-keys.json" 2>/dev/null || true
chmod 600 "${REV4A_ROOT}/data/agents-token.json" 2>/dev/null || true

echo ""
echo "=============================================="
echo "  Restore complete!"
echo "=============================================="
echo ""
echo "  Previous state saved to: ${PRE_DIR}"
echo ""
echo "  To restart Rev4a:"
echo "    sudo systemctl start rev4a.service"
echo ""
echo "  If something went wrong, restore previous state from:"
echo "    ${PRE_DIR}"
echo "=============================================="
