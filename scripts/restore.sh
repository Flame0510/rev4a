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
# into a false refusal on large archives. It is piped, not passed as a here-string: bash 5.2 on
# macOS can block forever writing a large here-string into a pipe (seen in heredoc_write).
LISTING="$(tar -tvzf "$ARCHIVE")"
if ! printf '%s\n' "$LISTING" | grep -E '[[:space:]]\./(\.env|data/)' >/dev/null; then
  echo "Error: $ARCHIVE does not look like a Rev4a data backup (no .env or data/ inside)." >&2
  exit 1
fi
# backup.sh never stores links; a link in the archive could point outside the data directory.
if printf '%s\n' "$LISTING" | grep -E '^[lh]' >/dev/null; then
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
# Top-level entries except backups, NUL-separated: --exclude would also drop nested backups/ on bsdtar.
(cd "$DATA_DIR" && find . -mindepth 1 -maxdepth 1 ! -name backups -print0) | tar -C "$DATA_DIR" --null -T - -czf - > "$PRE"
set +o noclobber
chmod 600 "$PRE"

# Extract next to the data directory, then swap: a failed extraction leaves the current
# data untouched, and nothing from the current state survives into the restored one.
PARENT="$(dirname "$DATA_DIR")"
STAGE="$(mktemp -d "${PARENT}/.rev4a-restore.XXXXXX")"
# KEEP holds the agent backup archives (backups/) while the swap runs. It sits next to the data
# directory, outside STAGE and outside every cleanup below: nothing in this script ever deletes it.
KEEP="${PARENT}/.rev4a-keep-backups.$$"
OLD="${PARENT}/.rev4a-replaced.$$"

# A name for a file that must be set aside: <name>.from-restore-archive, then .1, .2, ... Never an existing name.
free_aside_name() {
  local base="$1.from-restore-archive" cand n=0
  cand="$base"
  while [[ -e "$cand" || -L "$cand" ]]; do
    n=$((n + 1))
    cand="$base.$n"
  done
  printf '%s' "$cand"
}

# Put the kept backups back into the data directory, file by file. A current file always gets its own name
# back: a file of the same name that came out of the archive is first moved aside (see free_aside_name).
# Nothing here relies on the exit code of `mv -n` (it differs between BSD and GNU): existence is tested first.
# Whatever cannot be put back stays in KEEP.
merge_kept_backups() {
  [[ -d "$KEEP" ]] || return 0
  [[ -d "$DATA_DIR" ]] || return 1
  mkdir -p "$DATA_DIR/backups" && chmod 700 "$DATA_DIR/backups" || return 1
  local f dest aside
  for f in "$KEEP"/* "$KEEP"/.[!.]*; do
    [[ -e "$f" || -L "$f" ]] || continue
    dest="$DATA_DIR/backups/${f##*/}"
    if [[ -e "$dest" || -L "$dest" ]]; then
      aside="$(free_aside_name "$dest")"
      mv "$dest" "$aside" || return 1
    fi
    [[ -e "$dest" || -L "$dest" ]] && return 1
    mv "$f" "$dest" || return 1
  done
  rmdir "$KEEP" 2>/dev/null || true
  return 0
}

SWAPPING=""
on_exit() {
  local rc=$?
  # STAGE only ever holds what the archive extracted; the backups are in KEEP.
  rm -rf "$STAGE"
  # The swap stopped between its two moves: put the previous data directory back where it was.
  if [[ -n "$SWAPPING" && -d "$OLD" && ! -e "$DATA_DIR" ]]; then
    mv "$OLD" "$DATA_DIR" 2>/dev/null || true
  fi
  if [[ -d "$KEEP" ]]; then
    merge_kept_backups || true
  fi
  if [[ "$rc" -ne 0 && -n "$SWAPPING" ]]; then
    [[ -d "$OLD" ]] && echo "The previous data directory is in $OLD (the restore did not complete)." >&2
    [[ -d "$DATA_DIR" ]] && echo "The data directory is $DATA_DIR." >&2
  fi
  if [[ -d "$KEEP" ]]; then
    echo "Your agent backups were NOT deleted: they are in $KEEP" >&2
    echo "Move them to $DATA_DIR/backups by hand." >&2
  fi
  exit "$rc"
}
trap on_exit EXIT

echo "Restoring into: $DATA_DIR"
tar -C "$STAGE" --no-same-owner -xzf "$ARCHIVE"
find "$STAGE" -type d -exec chmod 700 {} +
[[ -f "$STAGE/.env" ]] && chmod 600 "$STAGE/.env"
[[ -d "$STAGE/data" ]] && find "$STAGE/data" -type f -exec chmod 600 {} +

# Take the current backups out of the way first. They are not in a backup.sh archive; the swap below
# deletes the old directory, so they must not be in it. A `backups` that is a symbolic link is not moved:
# it is recreated after the swap (removing the old directory removes the link, never its target).
BACKUPS_LINK=""
if [[ -L "$DATA_DIR/backups" ]]; then
  BACKUPS_LINK="$(readlink "$DATA_DIR/backups")"
elif [[ -e "$DATA_DIR/backups" ]]; then
  mv "$DATA_DIR/backups" "$KEEP"
fi
SWAPPING=1
mv "$DATA_DIR" "$OLD"
mv "$STAGE" "$DATA_DIR"
if [[ -n "$BACKUPS_LINK" ]]; then
  # An archive's own backups/ is set aside, the link takes its place.
  if [[ -e "$DATA_DIR/backups" || -L "$DATA_DIR/backups" ]]; then
    mv "$DATA_DIR/backups" "$(free_aside_name "$DATA_DIR/backups")"
  fi
  ln -s "$BACKUPS_LINK" "$DATA_DIR/backups"
fi
merge_kept_backups
# OLD no longer holds backups/ (moved to KEEP above, or a link), so removing it cannot delete one.
rm -rf "$OLD"
SWAPPING=""
trap - EXIT
if [[ -d "$KEEP" ]]; then
  echo "Your agent backups were NOT deleted: they are in $KEEP" >&2
fi

echo ""
echo "Restore complete."
echo "The previous state is in: $PRE"
[[ -n "${STOPPED:-}" ]] && echo "Start Rev4a again: systemctl start rev4a.service"
exit 0
