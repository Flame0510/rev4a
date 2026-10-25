#!/usr/bin/env bash
# backup.sh — archive Rev4a's own data directory
#
# Usage:
#   bash scripts/backup.sh                    # archive into ~/rev4a-backups/
#   bash scripts/backup.sh /path/to/backups   # custom destination
#
# What it archives: the whole Rev4a data directory — $REV4A_DATA_DIR when set,
# otherwise ~/.config/rev4a (the same rule as lib/rev4a-paths.ts). That is `.env`
# (secrets and configuration), everything under `data/` (events.db, metrics.db and
# credentials.db with their -wal/-shm files, provider-keys.json, agents-token.json, model
# overrides, the update log) and `shared/` (shared skills and rules). New files there are included
# automatically.
#
# Not included: agent volumes (the cold backups in the dashboard cover those), the agent
# backup archives in backups/ (plain agent-*.tar.gz files, often gigabytes: copy that folder
# yourself, it is safe to copy while Rev4a runs), the installed package, node_modules, .next.
#
# The archive holds every Rev4a secret in plain text: it is created with mode 0600, and a
# destination directory the script creates gets mode 0700 (an existing one is left as it
# is). Keep a copy off the machine, stored securely.
# For a fully consistent database copy, stop Rev4a first (`systemctl stop rev4a`);
# a copy taken while it runs is normally fine, since SQLite keeps its WAL alongside.
set -euo pipefail

DATA_DIR="${REV4A_DATA_DIR:-${HOME}/.config/rev4a}"
BACKUP_DIR="${1:-${HOME}/rev4a-backups}"

if [[ ! -d "$DATA_DIR" ]]; then
  echo "Error: Rev4a data directory not found: $DATA_DIR" >&2
  echo "Set REV4A_DATA_DIR if Rev4a keeps its data elsewhere." >&2
  exit 1
fi
if [[ ! -f "$DATA_DIR/.env" && ! -d "$DATA_DIR/data" ]]; then
  echo "Error: $DATA_DIR has neither .env nor data/ — refusing to archive an unrelated directory." >&2
  exit 1
fi

umask 077
mkdir -p "$BACKUP_DIR"
# The archive must not end up inside what it archives. Both paths are compared once they
# exist and with symlinks resolved, so a relative or linked destination cannot slip past.
case "$(cd "$BACKUP_DIR" && pwd -P)/" in
  "$(cd "$DATA_DIR" && pwd -P)/"*) echo "Error: the destination is inside the data directory." >&2; exit 1 ;;
esac

ARCHIVE="${BACKUP_DIR}/rev4a-backup-$(date -u +%Y%m%d-%H%M%S).tar.gz"
echo "Backing up Rev4a data"
echo "  Source: $DATA_DIR"
echo "  Target: $ARCHIVE"

# noclobber: a second backup in the same second fails instead of overwriting the first.
set -o noclobber
# Only the top-level backups entry is left out. --exclude would match a directory named
# backups at any depth on bsdtar (macOS), so the top-level entries are listed instead (NUL-separated).
(cd "$DATA_DIR" && find . -mindepth 1 -maxdepth 1 ! -name backups -print0) | tar -C "$DATA_DIR" --null -T - -czf - > "$ARCHIVE"
set +o noclobber
chmod 600 "$ARCHIVE"

echo ""
echo "Backup complete: $(tar -tzf "$ARCHIVE" | grep -vc '/$') files, $(du -h "$ARCHIVE" | cut -f1)"
echo "It contains plain-text secrets (.env, keys, credentials): keep a copy off this machine, stored securely."
echo "To restore: bash scripts/restore.sh $ARCHIVE"
