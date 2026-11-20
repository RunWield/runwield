#!/bin/sh
# Report the repository's exact Bun pin without requiring an installed Bun.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
pin_file="$root/.bun-version"
if ! version=$(cat "$pin_file") ||
    ! printf '%s\n' "$version" | grep -Eq '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' ||
    [ "$(printf '%s\n' "$version" | wc -l | tr -d ' ')" -ne 1 ]; then
    printf 'Expected one stable Bun version (major.minor.patch) in %s.\n' "$pin_file" >&2
    exit 1
fi
printf '%s\n' "$version"
