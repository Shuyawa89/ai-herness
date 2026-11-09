#!/usr/bin/env bash
set -euo pipefail

SKILL_DIRECTORY="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
OUTPUT="${1:-${HOME}/.local/state/task-dashboard/bin/task-dashboard}"
mkdir -p -- "$(dirname -- "$OUTPUT")"
OUTPUT="$(cd -- "$(dirname -- "$OUTPUT")" && pwd -P)/$(basename -- "$OUTPUT")"
TEMPORARY="$(mktemp "${OUTPUT}.build.XXXXXX")"
trap 'rm -f -- "$TEMPORARY"' EXIT
cd -- "$SKILL_DIRECTORY"

# The compiled binary needs no Go installation; only setup uses the toolchain.
if command -v go >/dev/null 2>&1; then
  go build -trimpath -o "$TEMPORARY" ./tool
elif command -v mise >/dev/null 2>&1; then
  mise exec go@1.27.2 -- go build -trimpath -o "$TEMPORARY" ./tool
else
  printf '%s\n' 'Build requires Go (or mise with Go 1.27.2). No server was started.' >&2
  exit 1
fi
chmod 700 "$TEMPORARY"
mv -f -- "$TEMPORARY" "$OUTPUT"
printf '%s\n' "$OUTPUT"
