#!/usr/bin/env bash
# test-release-version.sh — tests the version validation in release-publish.yml
#
# The function below must stay identical to the "Resolve and validate the version"
# step of .github/workflows/release-publish.yml. Change one and you must change the
# other: this is a copy on purpose, since the workflow cannot be unit-tested in
# place.
#
# Run it with:
#
#   bash scripts/test-release-version.sh
#
# It prints one line per case and exits non-zero if any case does not match.
set -euo pipefail

# Copy of the validation logic in .github/workflows/release-publish.yml.
# Returns 0 when the input is a valid version, 1 otherwise.
validate_version() {
  local RAW="$1"
  local VERSION="${RAW#v}"

  # A newline or a carriage return would let the value inject extra lines into
  # $GITHUB_OUTPUT, so refuse it before anything is written there.
  if [[ "$VERSION" == *$'\n'* || "$VERSION" == *$'\r'* ]]; then
    return 1
  fi

  # grep matches per line, so '^...$' was not a whole-string match: "1.2.3\nfoo"
  # passed it. This bash regex anchors ^ and $ to the whole string.
  if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
    return 1
  fi

  return 0
}

failures=0

# check <expectation> <description> <value>
# expectation is "pass" or "fail".
check() {
  local expected="$1"
  local description="$2"
  local value="$3"
  local actual

  if validate_version "$value"; then
    actual="pass"
  else
    actual="fail"
  fi

  if [[ "$actual" == "$expected" ]]; then
    printf 'ok   %-4s %s\n' "$expected" "$description"
  else
    printf 'FAIL expected %s but got %s: %s\n' "$expected" "$actual" "$description" >&2
    failures=$((failures + 1))
  fi
}

# Valid versions.
check pass "plain semver"            "1.2.3"
check pass "release tag with v"      "v1.2.3"
check pass "prerelease"              "1.2.3-rc.1"

# Invalid versions: a grep-per-line check would have accepted the first two.
check fail "newline injection"       $'1.2.3\nfoo'
check fail "carriage return"         $'1.2.3\rfoo'
check fail "trailing space"          "1.2.3 "
check fail "missing patch"           "1.2"
check fail "too many segments"       "1.2.3.4"
check fail "empty"                   ""
check fail "non-numbers"             "a.b.c"
check fail "shell metacharacters"    "1.2.3;rm -rf /"

if [[ "$failures" -gt 0 ]]; then
  printf '\n%d case(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nall cases passed\n'
