#!/usr/bin/env bash
# restore.sh — restore Rev4a's data directory from a backup.sh archive
#
# Usage:
#   bash scripts/restore.sh ~/rev4a-backups/rev4a-backup-20260926-120000.tar.gz
#
# Restores into $REV4A_DATA_DIR when set, otherwise ~/.config/rev4a — the directory
# backup.sh archived. Run it as the user Rev4a runs as: under `sudo` HOME becomes /root
# and REV4A_DATA_DIR is dropped, so pass it explicitly (`sudo REV4A_DATA_DIR=… bash …`).
#
# The data directory is replaced as a whole, not overwritten file by file: a file the
# backup does not have (a leftover SQLite -wal, for one) would otherwise be mixed into
# the restored state. The current contents are archived first into ~/rev4a-backups, so a
# restore can itself be undone.
#
# Rev4a must not be running. When the rev4a systemd service is active it is stopped (and
# must be started again afterwards); a `rev4a serve` started any other way makes the
# script refuse until it is stopped.
set -euo pipefail

DATA_DIR="${REV4A_DATA_DIR:-${HOME}/.config/rev4a}"
PRE_DIR="${HOME}/rev4a-backups"
ARCHIVE="${1:-}"

if [[ -z "$ARCHIVE" ]]; then
  echo "Usage: bash scripts/restore.sh <rev4a-backup-….tar.gz>"
  echo ""
  echo "Backups in ~/rev4a-backups:"
  ls -lh "${HOME}/rev4a-backups/"rev4a-backup-*.tar.gz 2>/dev/null || echo "  (none)"
  exit 1
fi
if [[ ! -f "$ARCHIVE" ]]; then
  echo "Error: archive not found: $ARCHIVE" >&2
  exit 1
fi
if [[ ! -d "$DATA_DIR" ]]; then
  # Restoring into a directory nothing reads would "succeed" and change nothing. On a new
  # machine, create it first — the check is only there to catch a wrong path.
  echo "Error: Rev4a data directory not found: $DATA_DIR" >&2
  echo "Set REV4A_DATA_DIR to the directory Rev4a uses, or create it first on a new machine." >&2
  exit 1
fi
# The real directory: when the path is a symlink, the swap below replaces its target.
DATA_DIR="$(cd "$DATA_DIR" && pwd -P)"

# Refuse an archive that is not a backup.sh archive of a Rev4a data directory. The listing
# is read whole: `grep -q` would stop reading early and, with pipefail, turn tar's SIGPIPE
# into a false refusal on large archives.
LISTING="$(tar -tvzf "$ARCHIVE")"
if ! grep -E '[[:space:]]\./(\.env|data/)' <<<"$LISTING" >/dev/null; then
  echo "Error: $ARCHIVE does not look like a Rev4a data backup (no .env or data/ inside)." >&2
  exit 1
fi
# backup.sh never stores links; a link in the archive could point outside the data directory.
if grep -E '^[lh]' <<<"$LISTING" >/dev/null; then
  echo "Error: $ARCHIVE contains symbolic or hard links — refusing to restore it." >&2
  exit 1
fi

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet rev4a.service 2>/dev/null; then
  echo "Stopping rev4a.service..."
  systemctl stop rev4a.service
  STOPPED=1
fi
if pgrep -f 'rev4a(\.js)? serve' >/dev/null 2>&1; then
  echo "Error: Rev4a is running (rev4a serve). Stop it first: it keeps the databases open." >&2
  exit 1
fi

umask 077
mkdir -p "$PRE_DIR"
PRE="${PRE_DIR}/rev4a-pre-restore-$(date -u +%Y%m%d-%H%M%S).tar.gz"
echo "Archiving the current state first: $PRE"
set -o noclobber
tar -C "$DATA_DIR" -czf - . > "$PRE"
set +o noclobber
chmod 600 "$PRE"

# Extract next to the data directory, then swap: a failed extraction leaves the current
# data untouched, and nothing from the current state survives into the restored one.
PARENT="$(dirname "$DATA_DIR")"
STAGE="$(mktemp -d "${PARENT}/.rev4a-restore.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
echo "Restoring into: $DATA_DIR"
tar -C "$STAGE" --no-same-owner -xzf "$ARCHIVE"
find "$STAGE" -type d -exec chmod 700 {} +
[[ -f "$STAGE/.env" ]] && chmod 600 "$STAGE/.env"
[[ -d "$STAGE/data" ]] && find "$STAGE/data" -type f -exec chmod 600 {} +

OLD="${PARENT}/.rev4a-replaced.$$"
mv "$DATA_DIR" "$OLD"
mv "$STAGE" "$DATA_DIR"
trap - EXIT
rm -rf "$OLD"

echo ""
echo "Restore complete."
echo "The previous state is in: $PRE"
[[ -n "${STOPPED:-}" ]] && echo "Start Rev4a again: systemctl start rev4a.service"
exit 0
