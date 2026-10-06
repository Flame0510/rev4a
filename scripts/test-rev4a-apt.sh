#!/usr/bin/env bash
# test-rev4a-apt.sh — tests the apt recorder and the restore planning of the base image
#
# Drives agent-templates/base-image/rev4a-apt with a fake apt-get and a fake
# dpkg-query in a temp dir (the scripts take the real binaries, the state dir, the
# baseline and a filesystem prefix from the environment), then runs the restore's
# planning step. Bash only; runs under bash 3.2.
#
# Run it with:
#
#   bash scripts/test-rev4a-apt.sh
#
# It prints one line per case and exits non-zero if any case fails.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
SRC="$HERE/../agent-templates/base-image"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/rev4a-apt-test.XXXXXX")
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); echo "ok   - $1"; }
bad() { FAIL=$((FAIL + 1)); echo "FAIL - $1"; [ -z "${2:-}" ] || echo "       $2"; }
check() { # check <description> <expected> <actual>
  if [ "$2" = "$3" ]; then ok "$1"; else bad "$1" "expected [$2] got [$3]"; fi
}

# The recorder is named apt-get / apt through symlinks, as in the image.
BIN="$TMP/bin"
mkdir -p "$BIN"
ln -s "$SRC/rev4a-apt" "$BIN/apt-get"
ln -s "$SRC/rev4a-apt" "$BIN/apt"

# Fake apt-get: succeeds unless FAKE_APT_RC is set; prints its arguments.
cat > "$TMP/fake-apt" <<'FAKE'
#!/bin/bash
echo "fake apt: $*"
exit "${FAKE_APT_RC:-0}"
FAKE
# Fake dpkg-query: "name|version" lines of $FAKE_DPKG_DB, "ii |version" when present.
cat > "$TMP/fake-dpkg-query" <<'FAKE'
#!/bin/bash
name=${*: -1}
line=$(grep -F "${name}|" "$FAKE_DPKG_DB" 2>/dev/null | head -n 1)
[ -n "$line" ] || exit 1
printf 'ii |%s\n' "${line#*|}"
FAKE
chmod +x "$TMP/fake-apt" "$TMP/fake-dpkg-query"

export FAKE_DPKG_DB="$TMP/dpkg.db"
export REV4A_APT_REAL="$TMP/fake-apt"
export REV4A_DPKG_QUERY="$TMP/fake-dpkg-query"
export REV4A_STATE_DIR="$TMP/state"
export REV4A_APT_BASELINE="$TMP/baseline"
export REV4A_FS_ROOT="$TMP/root"

# The "image": one source and one key that belong to it.
mkdir -p "$TMP/root/etc/apt/sources.list.d" "$TMP/root/usr/share/keyrings" "$TMP/root/etc/apt/keyrings"
echo "deb gh" > "$TMP/root/etc/apt/sources.list.d/github-cli.list"
echo "ghkey" > "$TMP/root/usr/share/keyrings/githubcli-archive-keyring.gpg"
REV4A_FS_ROOT="$TMP/root" "$SRC/rev4a-apt" --list-config > "$TMP/baseline"
check "baseline lists the image files" "/etc/apt/sources.list.d/github-cli.list
/usr/share/keyrings/githubcli-archive-keyring.gpg" "$(cat "$TMP/baseline")"

LIST="$TMP/state/packages.txt"
list() { cat "$LIST" 2>/dev/null; }
reset() { rm -rf "$TMP/state"; unset FAKE_APT_RC; }

printf 'postgresql-client-17|17.2-1.pgdg120+1\nlibpq5|17.2-1.pgdg120+1\njq|1.6-2.1\nwget|1.21.3-1\n' > "$FAKE_DPKG_DB"

# --- install records the named packages with their version, not dependencies
reset
out=$("$BIN/apt-get" install -y postgresql-client-17 2>"$TMP/err"); rc=$?
check "install keeps the exit code" "0" "$rc"
check "install output is the real output" "fake apt: install -y postgresql-client-17" "$out"
check "install records name=version, not dependencies" "postgresql-client-17=17.2-1.pgdg120+1" "$(list)"

# --- several packages, version and release forms, options with values
reset
"$BIN/apt-get" -o Dpkg::Options::=--force-confold install -y -t bookworm jq=1.6-2.1 wget/bookworm >/dev/null 2>&1
check "pkg=ver and pkg/release forms" "jq=1.6-2.1
wget=1.21.3-1" "$(list)"

# --- apt works the same
reset
"$BIN/apt" install jq >/dev/null 2>&1
check "apt install is recorded" "jq=1.6-2.1" "$(list)"

# --- simulate and download-only are not recorded
reset
for flag in -s --simulate --dry-run --download-only -d -sy; do
  "$BIN/apt-get" install $flag jq >/dev/null 2>&1
  [ ! -f "$LIST" ] && ok "install $flag is not recorded" || bad "install $flag is not recorded" "$(list)"
  reset
done

# --- other subcommands are not recorded
reset
"$BIN/apt-get" update >/dev/null 2>&1
"$BIN/apt-get" upgrade -y >/dev/null 2>&1
[ ! -f "$LIST" ] && ok "update and upgrade are not recorded" || bad "update and upgrade are not recorded"

# --- failed install: not recorded, exit code kept
reset
FAKE_APT_RC=100 "$BIN/apt-get" install jq >/dev/null 2>&1; rc=$?
check "failed install keeps the exit code" "100" "$rc"
[ ! -f "$LIST" ] && ok "failed install is not recorded" || bad "failed install is not recorded" "$(list)"

# --- local .deb skipped with a note
reset
"$BIN/apt-get" install ./x.deb jq >/dev/null 2>"$TMP/err"
check "local .deb skipped, others recorded" "jq=1.6-2.1" "$(list)"
grep -q "local package file ./x.deb" "$TMP/err" && ok "local .deb produces a note" || bad "local .deb produces a note"

# --- remove and purge drop the entry
reset
"$BIN/apt-get" install jq wget >/dev/null 2>&1
"$BIN/apt-get" remove -y jq >/dev/null 2>&1
check "remove drops the entry" "wget=1.21.3-1" "$(list)"
"$BIN/apt-get" purge -y wget >/dev/null 2>&1
check "purge drops the entry" "" "$(list)"
reset
"$BIN/apt-get" install jq >/dev/null 2>&1
FAKE_APT_RC=100 "$BIN/apt-get" remove jq >/dev/null 2>&1
check "failed remove keeps the entry" "jq=1.6-2.1" "$(list)"
"$BIN/apt-get" remove -s jq >/dev/null 2>&1
check "simulated remove keeps the entry" "jq=1.6-2.1" "$(list)"

# --- reinstall of a newer version updates the entry, unique by name
reset
"$BIN/apt-get" install jq >/dev/null 2>&1
printf 'jq|1.7-1\n' > "$FAKE_DPKG_DB.new"; grep -v '^jq|' "$FAKE_DPKG_DB" >> "$FAKE_DPKG_DB.new"; mv "$FAKE_DPKG_DB.new" "$FAKE_DPKG_DB"
"$BIN/apt-get" install jq >/dev/null 2>&1
check "reinstall updates the version, one line per name" "jq=1.7-1" "$(list)"
printf 'postgresql-client-17|17.2-1.pgdg120+1\nlibpq5|17.2-1.pgdg120+1\njq|1.6-2.1\nwget|1.21.3-1\n' > "$FAKE_DPKG_DB"

# --- a name dpkg does not know (virtual or typo) is skipped with a note
reset
"$BIN/apt-get" install nosuch jq >/dev/null 2>"$TMP/err"
check "unknown name is not recorded" "jq=1.6-2.1" "$(list)"
grep -q "nosuch" "$TMP/err" && ok "unknown name produces a note" || bad "unknown name produces a note"

# --- new source + key copied, baseline files not; stale copies pruned
reset
echo "deb pgdg" > "$TMP/root/etc/apt/sources.list.d/pgdg.list"
echo "pgkey" > "$TMP/root/etc/apt/keyrings/pgdg.asc"
"$BIN/apt-get" install postgresql-client-17 >/dev/null 2>&1
S="$TMP/state/apt"
[ "$(cat "$S/etc/apt/sources.list.d/pgdg.list" 2>/dev/null)" = "deb pgdg" ] && ok "new source is copied under its path" || bad "new source is copied under its path"
[ "$(cat "$S/etc/apt/keyrings/pgdg.asc" 2>/dev/null)" = "pgkey" ] && ok "new key is copied under its path" || bad "new key is copied under its path"
[ ! -e "$S/etc/apt/sources.list.d/github-cli.list" ] && [ ! -e "$S/usr/share/keyrings/githubcli-archive-keyring.gpg" ] \
  && ok "baseline files are not copied" || bad "baseline files are not copied"
rm "$TMP/root/etc/apt/sources.list.d/pgdg.list"
"$BIN/apt-get" install jq >/dev/null 2>&1
[ ! -e "$S/etc/apt/sources.list.d/pgdg.list" ] && ok "a deleted source is dropped from the copy" || bad "a deleted source is dropped from the copy"
rm -f "$TMP/root/etc/apt/keyrings/pgdg.asc"

# --- a recording error keeps the exit code and prints one line
reset
mkdir -p "$TMP/blocked"; echo x > "$TMP/blocked/file"
out=$(REV4A_STATE_DIR="$TMP/blocked/file/state" "$BIN/apt-get" install jq 2>"$TMP/err"); rc=$?
check "recording error keeps the exit code" "0" "$rc"
check "recording error leaves the output alone" "fake apt: install jq" "$out"
n=$(grep -c '^\[rev4a-apt\] ' "$TMP/err")
[ "$n" -ge 1 ] && ok "recording error is reported as [rev4a-apt] on stderr" || bad "recording error is reported on stderr"
FAKE_APT_RC=7 REV4A_STATE_DIR="$TMP/blocked/file/state" "$BIN/apt-get" install jq >/dev/null 2>&1; rc=$?
check "a failing command with a recording error keeps its code" "7" "$rc"

# --- restore planning: which recorded packages are missing
reset
mkdir -p "$TMP/state"
printf 'jq=1.6-2.1\r\ngone=2.0\r\n# comment\n\n-evil=1\nBad Name=1\nnoversion\nspace=1 2\npostgresql-client-17=17.2-1.pgdg120+1\ng++=13.2\n' > "$LIST"
plan=$("$SRC/rev4a-packages-restore" --plan 2>"$TMP/err")
check "restore plans the missing packages only, sanitizing the list" "gone=2.0
g++=13.2" "$plan"
grep -q "ignored 4 invalid" "$TMP/err" && ok "restore logs one line for ignored lines" || bad "restore logs one line for ignored lines" "$(cat "$TMP/err")"
rm -f "$LIST"
check "restore plans nothing without a list" "" "$("$SRC/rev4a-packages-restore" --plan)"

# --- restore with nothing missing writes the status and does not need apt
reset
mkdir -p "$TMP/state"
printf 'jq=1.6-2.1\n' > "$LIST"
REV4A_REAL_APT_GET=/nonexistent "$SRC/rev4a-packages-restore" >/dev/null 2>&1; rc=$?
check "restore with nothing missing exits 0" "0" "$rc"
grep -q '"state": "nothing-to-do"' "$TMP/state/packages-status.json" && ok "status says nothing-to-do" || bad "status says nothing-to-do" "$(cat "$TMP/state/packages-status.json" 2>/dev/null)"

# --- restore puts saved files back, then installs the missing package
reset
mkdir -p "$TMP/state/apt/etc/apt/sources.list.d"
echo "deb pgdg" > "$TMP/state/apt/etc/apt/sources.list.d/pgdg.list"
printf 'gone=2.0\n' > "$LIST"
REV4A_REAL_APT_GET="$TMP/fake-apt" "$SRC/rev4a-packages-restore" >"$TMP/restore.log" 2>&1
[ "$(cat "$TMP/root/etc/apt/sources.list.d/pgdg.list" 2>/dev/null)" = "deb pgdg" ] && ok "restore puts the saved source back" || bad "restore puts the saved source back"
grep -q '"state": "ok"' "$TMP/state/packages-status.json" && grep -q '"restored": \["gone"\]' "$TMP/state/packages-status.json" \
  && ok "status lists the restored package" || bad "status lists the restored package" "$(cat "$TMP/state/packages-status.json" 2>/dev/null)"
rm -f "$TMP/root/etc/apt/sources.list.d/pgdg.list"

# --- recorder: keys named by a new source are saved and restored, never overwritten
reset
R="$TMP/root2"
rm -rf "$R"
mkdir -p "$R/etc/apt/sources.list.d" "$R/usr/share/postgresql-common/pgdg" "$R/opt/k" "$R/root" "$R/usr/share/keyrings"
echo "ghkey" > "$R/usr/share/keyrings/githubcli-archive-keyring.gpg"
echo "deb gh" > "$R/etc/apt/sources.list.d/github-cli.list"
echo "pgkey" > "$R/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc"
echo "k1" > "$R/opt/k/one.gpg"; echo "k2" > "$R/opt/k/two.gpg"; echo "k3" > "$R/opt/k/three.gpg"
echo "rootkey" > "$R/root/k.asc"
echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > "$R/etc/apt/sources.list.d/pgdg.list"
echo "deb [arch=amd64 signed-by=/opt/k/one.gpg,/opt/k/two.gpg] https://x bookworm main" > "$R/etc/apt/sources.list.d/multi.list"
echo "deb [signed-by=/root/k.asc] https://r bookworm main" > "$R/etc/apt/sources.list.d/root.list"
echo "deb [signed-by=keys/relative.gpg] https://rel bookworm main" > "$R/etc/apt/sources.list.d/rel.list"
printf 'Types: deb\nURIs: https://y\nSuites: bookworm\nSigned-By: /opt/k/three.gpg\n' > "$R/etc/apt/sources.list.d/y.sources"
printf 'Types: deb\nURIs: https://z\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n /opt/k/inline.gpg\n -----END PGP PUBLIC KEY BLOCK-----\n' > "$R/etc/apt/sources.list.d/z.sources"
REV4A_FS_ROOT="$R" "$SRC/rev4a-apt" --list-config > "$TMP/baseline2.tmp"
# the baseline is the image: only the github files
printf '/etc/apt/sources.list.d/github-cli.list\n/usr/share/keyrings/githubcli-archive-keyring.gpg\n' > "$TMP/baseline2"
REV4A_FS_ROOT="$R" REV4A_APT_BASELINE="$TMP/baseline2" "$BIN/apt-get" install -y postgresql-client-17 >/dev/null 2>&1
S="$TMP/state/apt"
[ "$(cat "$S/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" 2>/dev/null)" = "pgkey" ] && ok "signed-by key outside the apt dirs is saved" || bad "signed-by key outside the apt dirs is saved"
[ -f "$S/opt/k/one.gpg" ] && [ -f "$S/opt/k/two.gpg" ] && ok "comma-separated signed-by keys are saved" || bad "comma-separated signed-by keys are saved"
[ -f "$S/opt/k/three.gpg" ] && ok "deb822 Signed-By path is saved" || bad "deb822 Signed-By path is saved"
[ ! -e "$S/root" ] && ok "a key under /root is not saved" || bad "a key under /root is not saved"
[ ! -e "$S/opt/k/inline.gpg" ] && [ ! -e "$S/keys" ] && ok "inline and relative keys are ignored" || bad "inline and relative keys are ignored"
[ ! -e "$S/usr/share/keyrings/githubcli-archive-keyring.gpg" ] && ok "baseline keys are not saved" || bad "baseline keys are not saved"
# a key whose source is gone is pruned
rm -f "$R/etc/apt/sources.list.d/multi.list"
REV4A_FS_ROOT="$R" REV4A_APT_BASELINE="$TMP/baseline2" "$BIN/apt-get" install -y jq >/dev/null 2>&1
[ ! -e "$S/opt/k/one.gpg" ] && [ -f "$S/opt/k/three.gpg" ] && ok "keys of a deleted source are pruned" || bad "keys of a deleted source are pruned"
# restore into a fresh root: files back at the same paths, existing files untouched
R3="$TMP/root3"; rm -rf "$R3"; mkdir -p "$R3/opt/k"
echo "local" > "$R3/opt/k/three.gpg"
printf 'jq=1.6-2.1\n' > "$TMP/state/packages.txt"
REV4A_FS_ROOT="$R3" "$SRC/rev4a-packages-restore" >/dev/null 2>&1
[ "$(cat "$R3/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc" 2>/dev/null)" = "pgkey" ] && ok "restore puts the key back, creating directories" || bad "restore puts the key back, creating directories"
[ "$(cat "$R3/opt/k/three.gpg")" = "local" ] && ok "restore never overwrites an existing file" || bad "restore never overwrites an existing file"
[ -f "$R3/etc/apt/sources.list.d/pgdg.list" ] && ok "restore puts the source back" || bad "restore puts the source back"

# --- trailing + : g++ is a package name, foo+ installs foo
reset
printf 'g++|4:12.2.0-3\nfoo|1.0\n' >> "$FAKE_DPKG_DB"
"$BIN/apt-get" install -y g++ foo+ >/dev/null 2>&1
check "g++ keeps its name, foo+ is recorded as foo" "foo=1.0
g++=4:12.2.0-3" "$(list)"
printf 'postgresql-client-17|17.2-1.pgdg120+1\nlibpq5|17.2-1.pgdg120+1\njq|1.6-2.1\nwget|1.21.3-1\n' > "$FAKE_DPKG_DB"

# --- simulation through apt configuration, short clusters
reset
for opts in "-o APT::Get::Simulate=true" "-oAPT::Get::Simulate=yes" "-o apt::get::download-only=1" \
            "--option=APT::Get::Simulate=TRUE" "--option APT::Get::Download-Only=True"; do
  # shellcheck disable=SC2086
  "$BIN/apt-get" $opts install jq >/dev/null 2>&1
  [ ! -f "$LIST" ] && ok "[$opts] is not recorded" || bad "[$opts] is not recorded" "$(list)"
  reset
done
for opts in "-o APT::Get::Simulate=false" "-ostuff" "-o Acquire::Foo=true" "-yt bookworm" "-qq -t bookworm"; do
  # shellcheck disable=SC2086
  "$BIN/apt-get" $opts install jq >/dev/null 2>&1
  [ "$(list)" = "jq=1.6-2.1" ] && ok "[$opts] is recorded" || bad "[$opts] is recorded" "$(list)"
  reset
done

# --- one stderr line on a recording failure, no mkdir/mktemp noise
reset
REV4A_STATE_DIR="$TMP/blocked/file/state" "$BIN/apt-get" install jq >/dev/null 2>"$TMP/err"
check "a recording failure prints exactly one line" "1" "$(wc -l < "$TMP/err" | tr -d ' ')"
grep -q '^\[rev4a-apt\] ' "$TMP/err" && ok "that line carries the prefix" || bad "that line carries the prefix" "$(cat "$TMP/err")"

# --- list sanitizing in the recorder: bad lines are dropped, CR stripped
reset
mkdir -p "$TMP/state"
printf 'wget=1.21.3-1\r\n-evil=1\n# c\nBad Name=2\n' > "$LIST"
"$BIN/apt-get" install jq >/dev/null 2>"$TMP/err"
check "invalid lines are dropped when the list is rewritten" "jq=1.6-2.1
wget=1.21.3-1" "$(list)"
grep -q "ignored 2 invalid" "$TMP/err" && ok "the recorder logs the ignored lines" || bad "the recorder logs the ignored lines" "$(cat "$TMP/err")"

# --- lock: a live holder makes the recorder skip (command unaffected); a stale lock is taken over
reset
mkdir -p "$TMP/state/.packages.lock"
sleep 30 & holder=$!
echo "$holder" > "$TMP/state/.packages.lock/pid"
out=$("$BIN/apt-get" install jq 2>"$TMP/err"); rc=$?
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "a held lock does not fail the command" "0" "$rc"
check "a held lock does not change the output" "fake apt: install jq" "$out"
[ ! -f "$LIST" ] && ok "a held lock skips recording" || bad "a held lock skips recording"
check "a held lock logs one line" "1" "$(wc -l < "$TMP/err" | tr -d ' ')"
rm -rf "$TMP/state/.packages.lock"; mkdir -p "$TMP/state/.packages.lock"; echo 999999 > "$TMP/state/.packages.lock/pid"
"$BIN/apt-get" install jq >/dev/null 2>&1
check "a stale lock is taken over" "jq=1.6-2.1" "$(list)"
[ ! -e "$TMP/state/.packages.lock" ] && ok "the lock is released" || bad "the lock is released"

# --- restore: fakes for apt-get and apt-cache
# Written in small chunks: bash 3.2 can hang on a large here-document.
: > "$TMP/fake-apt2"
cat >> "$TMP/fake-apt2" <<'FAKE'
#!/bin/bash
echo "$*" >> "$FAKE_APT_LOG"
add() { printf '%s|%s\n' "$1" "$2" >> "$FAKE_DPKG_DB"; }
case "$*" in
FAKE
cat >> "$TMP/fake-apt2" <<'FAKE'
  *" update") exit 0 ;;
  *"install -y old=1.0") echo "E: Version '1.0' for 'old' was not found"; exit 100 ;;
  *"install -y old") add old 2.0; exit 0 ;;
  *"install -y same=3.0") echo "E: Version '3.0' for 'same' was not found"; exit 100 ;;
FAKE
cat >> "$TMP/fake-apt2" <<'FAKE'
  *"install -y same") add same 3.0; exit 0 ;;
  *"install -y gen=1.0") echo "E: Some generic failure"; exit 100 ;;
  *"install -y gen") add gen 1.5; exit 0 ;;
  *"install -y drift=1.0") add drift 1.1; exit 0 ;;
FAKE
cat >> "$TMP/fake-apt2" <<'FAKE'
  *"install -y fine=1.0") add fine 1.0; exit 0 ;;
  *"install -y locked="*|*"install -y locked") echo "E: Could not get lock /var/lib/dpkg/lock"; exit 100 ;;
  *"install -y adv=1.0") cat "$FAKE_ADV_FILE"; exit 100 ;;
  *"install -y slow=1.0") sleep 30; exit 0 ;;
FAKE
cat >> "$TMP/fake-apt2" <<'FAKE'
  *"install -y bad="*|*"install -y bad") echo "E: Unable to locate package bad"; exit 100 ;;
esac
exit 0
FAKE
cat > "$TMP/fake-apt-cache" <<'FAKE'
#!/bin/bash
[ "$1" = madison ] && [ "$2" = gen ] && echo " gen | 1.5 | http://deb.example bookworm/main amd64 Packages"
exit 0
FAKE
chmod +x "$TMP/fake-apt2" "$TMP/fake-apt-cache"
export FAKE_APT_LOG="$TMP/apt2.log"
export REV4A_REAL_APT_CACHE="$TMP/fake-apt-cache"
jget() { # jget <file> <js expression on s>
  node -e 'const s=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")); process.stdout.write(String(eval(process.argv[2])))' "$1" "$2"
}
: > "$FAKE_DPKG_DB"
reset; : > "$FAKE_APT_LOG"
mkdir -p "$TMP/state"
printf 'old=1.0\nbad=1.0\nlocked=1.0\nsame=3.0\nfine=1.0\ndrift=1.0\ngen=1.0\n' > "$LIST"
REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >"$TMP/restore.log" 2>&1
ST="$TMP/state/packages-status.json"
check "restore: partial when some packages fail" "partial" "$(jget "$ST" 's.state')"
check "restore: restored lists every reinstalled package" "old,same,fine,drift,gen" "$(jget "$ST" 's.restored.join(",")')"
check "restore: versionChanged only where the installed version differs" "old,drift,gen" "$(jget "$ST" 's.versionChanged.join(",")')"
check "restore: failed lists the real failures" "bad,locked" "$(jget "$ST" 's.failed.map(f=>f.name).join(",")')"
grep -q "install -y locked$" "$FAKE_APT_LOG" && bad "a lock error does not fall back to the bare name" || ok "a lock error does not fall back to the bare name"
grep -q "install -y bad$" "$FAKE_APT_LOG" && bad "an unknown package does not fall back" || ok "an unknown package does not fall back"
grep -q "install -y gen$" "$FAKE_APT_LOG" && ok "madison saying the version is gone allows the fallback" || bad "madison saying the version is gone allows the fallback"
[ -z "$(ls -A "$TMP/state" | grep '^\.packages-run')" ] && ok "restore leaves no work directory" || bad "restore leaves no work directory"

# --- status JSON stays valid with adversarial errors at the 300-character cut
: > "$FAKE_DPKG_DB"
badjson=0
k=290
while [ $k -le 305 ]; do
  reset
  mkdir -p "$TMP/state"
  printf 'adv=1.0\n' > "$LIST"
  x=$(printf '%*s' "$k" '' | tr ' ' 'x')
  printf 'first\nline "two"\n%s\\"\\\\"\t\r\001\002 end"\\' "$x" > "$TMP/adv.txt"
  FAKE_ADV_FILE="$TMP/adv.txt" REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >/dev/null 2>&1
  len=$(jget "$ST" 's.failed[0].error.length' 2>/dev/null)
  if [ -z "$len" ] || [ "$len" -gt 300 ]; then badjson=$((badjson + 1)); echo "       cut=$k len=[$len]"; fi
  k=$((k + 1))
done
check "status JSON parses with quotes and backslashes at every cut" "0" "$badjson"

# --- restore writes only apt paths and the keys a saved source names
reset
R4="$TMP/root4"; rm -rf "$R4"; mkdir -p "$R4"
for p in etc/apt/sources.list.d/a.list opt/k2/a.gpg etc/cron.d/new etc/ld.so.preload usr/share/keyrings/x.gpg opt/other/b.gpg; do
  mkdir -p "$TMP/state/apt/$(dirname "$p")"; echo "$p" > "$TMP/state/apt/$p"
done
echo "deb [signed-by=/opt/k2/a.gpg] https://a bookworm main" > "$TMP/state/apt/etc/apt/sources.list.d/a.list"
REV4A_FS_ROOT="$R4" "$SRC/rev4a-packages-restore" > "$TMP/restore.log" 2>&1
[ -f "$R4/etc/apt/sources.list.d/a.list" ] && [ -f "$R4/opt/k2/a.gpg" ] && [ -f "$R4/usr/share/keyrings/x.gpg" ] \
  && ok "restore puts back apt files and a key a saved source names" || bad "restore puts back apt files and a key a saved source names"
[ ! -e "$R4/etc/cron.d/new" ] && [ ! -e "$R4/etc/ld.so.preload" ] && [ ! -e "$R4/opt/other/b.gpg" ] \
  && ok "restore ignores any other saved path" || bad "restore ignores any other saved path"
grep -q "ignored saved file /etc/cron.d/new" "$TMP/restore.log" && ok "each ignored path is logged" || bad "each ignored path is logged"

printf 'jq|1.6-2.1\n' > "$FAKE_DPKG_DB"
# --- lock recovery: reused live pid with an old lock, no pid file, unwritable state dir
reset
mkdir -p "$TMP/state/.packages.lock"
sleep 30 & holder=$!
echo "$holder" > "$TMP/state/.packages.lock/pid"
touch -t 200001010000 "$TMP/state/.packages.lock"
"$BIN/apt-get" install jq >/dev/null 2>&1
kill "$holder" 2>/dev/null; wait "$holder" 2>/dev/null
check "a lock older than a minute is stale even with a live pid" "jq=1.6-2.1" "$(list)"
reset
mkdir -p "$TMP/state/.packages.lock"
t0=$(date +%s)
"$BIN/apt-get" install jq >/dev/null 2>&1
t1=$(date +%s)
check "a lock without a pid file is taken over" "jq=1.6-2.1" "$(list)"
[ $((t1 - t0)) -le 4 ] && ok "that takeover takes about 2 seconds" || bad "that takeover takes about 2 seconds" "took $((t1 - t0))s"
reset
mkdir -p "$TMP/state"; chmod 555 "$TMP/state"
"$BIN/apt-get" install jq >/dev/null 2>"$TMP/err"; rc=$?
chmod 755 "$TMP/state"
check "an unwritable state dir keeps the exit code" "0" "$rc"
grep -q "not writable" "$TMP/err" && ok "an unwritable state dir is named as such" || bad "an unwritable state dir is named as such" "$(cat "$TMP/err")"

# --- deb822 Signed-By continuation lines
reset
R="$TMP/root5"; rm -rf "$R"
mkdir -p "$R/etc/apt/sources.list.d" "$R/opt/k"
for k in c1 c2 c3 c4 fake; do echo "$k" > "$R/opt/k/$k.gpg"; done
printf 'Types: deb\nSigned-By:\n /opt/k/c1.gpg\n /opt/k/c2.gpg\nSuites: x\n' > "$R/etc/apt/sources.list.d/c.sources"
printf 'Types: deb\nSigned-By: /opt/k/c3.gpg\n /opt/k/c4.gpg\nSuites: y\n' > "$R/etc/apt/sources.list.d/d.sources"
printf 'Types: deb\nSigned-By:\n -----BEGIN PGP PUBLIC KEY BLOCK-----\n /opt/k/fake.gpg\n -----END PGP PUBLIC KEY BLOCK-----\nSuites: z\n' > "$R/etc/apt/sources.list.d/e.sources"
: > "$TMP/baseline5"
REV4A_FS_ROOT="$R" REV4A_APT_BASELINE="$TMP/baseline5" "$BIN/apt-get" install jq >/dev/null 2>&1
S="$TMP/state/apt"
[ -f "$S/opt/k/c1.gpg" ] && [ -f "$S/opt/k/c2.gpg" ] && ok "Signed-By paths on indented continuation lines are saved" || bad "Signed-By paths on indented continuation lines are saved"
[ -f "$S/opt/k/c3.gpg" ] && [ -f "$S/opt/k/c4.gpg" ] && ok "Signed-By value followed by a continuation line is saved" || bad "Signed-By value followed by a continuation line is saved"
[ ! -e "$S/opt/k/fake.gpg" ] && ok "a line inside an inline armored key is not a path" || bad "a line inside an inline armored key is not a path"

# --- the 300-character cut is on characters, in any locale
: > "$FAKE_DPKG_DB"
reset
mkdir -p "$TMP/state"
printf 'adv=1.0\n' > "$LIST"
x=$(printf '%*s' 298 '' | tr ' ' 'x')
printf '%s\342\202\254\342\202\254\342\202\254\342\202\254\n' "$x" > "$TMP/adv.txt"
LC_ALL=C FAKE_ADV_FILE="$TMP/adv.txt" REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >/dev/null 2>&1
ST="$TMP/state/packages-status.json"
check "a multibyte cut leaves valid text" "ok" "$(jget "$ST" 's.failed[0].error.length<=300 && !s.failed[0].error.includes("�") ? "ok" : "bad:"+s.failed[0].error.length')"

# --- half-configured dpkg is repaired first
printf '%s\n' '#!/bin/bash' 'case "$*" in' '  *--audit*) [ -f "$FAKE_BROKEN" ] && echo "half-configured: foo" ;;' '  *--configure*) echo "$*" > "$FAKE_BROKEN.log"; rm -f "$FAKE_BROKEN" ;;' 'esac' 'exit 0' > "$TMP/fake-dpkg"
chmod +x "$TMP/fake-dpkg"
reset
mkdir -p "$TMP/state"
printf 'fine=1.0\n' > "$LIST"
: > "$FAKE_DPKG_DB"
echo x > "$TMP/broken"
FAKE_BROKEN="$TMP/broken" REV4A_REAL_DPKG="$TMP/fake-dpkg" REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >"$TMP/restore.log" 2>&1
grep -q -- "--configure -a" "$TMP/broken.log" 2>/dev/null && [ ! -e "$TMP/broken" ] && ok "restore runs dpkg --configure -a when dpkg is half-configured" || bad "restore runs dpkg --configure -a when dpkg is half-configured"
reset
mkdir -p "$TMP/state"; printf 'fine=1.0\n' > "$LIST"; : > "$FAKE_DPKG_DB"; rm -f "$TMP/broken.log"
FAKE_BROKEN="$TMP/broken" REV4A_REAL_DPKG="$TMP/fake-dpkg" REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >/dev/null 2>&1
[ ! -e "$TMP/broken.log" ] && ok "restore leaves a healthy dpkg alone" || bad "restore leaves a healthy dpkg alone"

# --- the deadline covers the whole run (a stand-in timeout(1) where the system has none)
FAKEBIN="$TMP/fakebin"
mkdir -p "$FAKEBIN"
printf '%s\n' '#!/bin/bash' 'shift 3' '"$@" & p=$!' 'sleep 1' 'kill $p 2>/dev/null; wait $p 2>/dev/null; exit 124' > "$FAKEBIN/timeout"
chmod +x "$FAKEBIN/timeout"
RUNPATH=$PATH
command -v timeout >/dev/null 2>&1 || RUNPATH="$FAKEBIN:$PATH"
: > "$FAKE_DPKG_DB"
reset
mkdir -p "$TMP/state"
printf 'slow=1.0\nfine=1.0\n' > "$LIST"
t0=$(date +%s)
PATH=$RUNPATH REV4A_PACKAGES_TIMEOUT=2 REV4A_REAL_APT_GET="$TMP/fake-apt2" "$SRC/rev4a-packages-restore" >/dev/null 2>&1
t1=$(date +%s)
[ $((t1 - t0)) -lt 20 ] && ok "a run that exceeds the deadline is stopped" || bad "a run that exceeds the deadline is stopped" "took $((t1 - t0))s"
check "timed-out packages are reported failed" "slow,fine" "$(jget "$ST" 's.failed.map(f=>f.name).join(",")')"
check "timed-out state is failed" "failed" "$(jget "$ST" 's.state')"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
