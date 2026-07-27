#!/usr/bin/env bash
# backup.sh — Backup Olympus data to a tar.gz archive
#
# Usage:
#   sudo bash scripts/backup.sh                     # backup to ./backups/
#   sudo bash scripts/backup.sh /path/to/backups    # custom directory
#
# What it backs up:
#   - data/*.db (events, credentials, lineage)
#   - data/provider-keys.json
#   - data/agents-token.json
#   - models.config.json
#   - .env (credentials and configuration)
#
# Does NOT back up:
#   - node_modules (can be reinstalled)
#   - .next build cache (can be rebuilt)
set -euo pipefail

# Resolve script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OLYMPUS_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BACKUP_DIR="${1:-${OLYMPUS_ROOT}/backups}"

mkdir -p "$BACKUP_DIR"

TS=$(date -u +%Y%m%d-%H%M%S)
ARCHIVE="${BACKUP_DIR}/olympus-backup-${TS}.tar.gz"

echo "Backing up Olympus data..."
echo "  Source: ${OLYMPUS_ROOT}"
echo "  Target: ${ARCHIVE}"

cd "$OLYMPUS_ROOT"

# Restrict permissions during archive creation
umask 077

# Create tar with only the files we care about
tar -czf "$ARCHIVE" \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='.git' \
  --exclude='backups' \
  data/*.db \
  data/*.db-shm \
  data/*.db-wal \
  data/provider-keys.json 2>/dev/null || true \
  data/agents-token.json 2>/dev/null || true \
  models.config.json 2>/dev/null || true \
  .env 2>/dev/null || true

echo ""
echo "=============================================="
echo "  Backup complete!"
echo "=============================================="
echo ""
echo "  Archive: ${ARCHIVE}"
echo "  Size:    $(du -h "$ARCHIVE" | cut -f1)"
echo ""
chmod 600 "$ARCHIVE"
echo "  WARNING: This archive contains plain-text credentials (.env)."
echo "  Store it securely (encrypted at rest recommended)."
echo ""
echo "  To restore: sudo bash scripts/restore.sh ${ARCHIVE}"
echo "=============================================="
