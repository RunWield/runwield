#!/bin/sh
# Use the checked-out Bun pin for Docker, Podman, and their Compose front ends.
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
engine=${RUNWIELD_CONTAINER_ENGINE:-podman}
case "$engine" in
    docker|podman) ;;
    *) echo "RUNWIELD_CONTAINER_ENGINE must be docker or podman." >&2; exit 2 ;;
esac
mode=${1:-}
case "$mode" in
    build|compose) shift ;;
    *) echo "Usage: sh scripts/plan-server-container.sh {build|compose} [options]" >&2; exit 2 ;;
esac
BUN_VERSION=$(sh "$root/scripts/read-bun-version.sh")
export BUN_VERSION
cd "$root"
case "$mode" in
    build) exec "$engine" build -f Containerfile "$@" --build-arg "BUN_VERSION=$BUN_VERSION" . ;;
    compose) exec "$engine" compose -f compose.yml "$@" ;;
esac
