#!/bin/sh
# Run with this checkout's toolchain. bun x caches the requested runtime locally.
set -eu
scripts=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
version=$(sh "$scripts/read-bun-version.sh")
if [ "$(bun --version)" = "$version" ]; then
    exec bun "$@"
fi
exec bun x "bun@$version" "$@"
