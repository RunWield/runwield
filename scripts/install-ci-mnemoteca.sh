#!/usr/bin/env bash
# Install the latest Stable Mnemoteca for real Work Record integration checks.
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
case "$(uname -s)" in
    Linux) platform=linux ;;
    Darwin) platform=darwin ;;
    *) echo "Unsupported Mnemoteca CI platform" >&2; exit 1 ;;
esac
case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) echo "Unsupported Mnemoteca CI architecture" >&2; exit 1 ;;
esac

tag=$(gh api repos/RunWield/mnemoteca/releases/latest --jq '.tag_name')
[[ "$tag" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Invalid Stable Mnemoteca tag: $tag" >&2; exit 1; }
asset="mnemoteca_${tag#v}_${platform}_${arch}.tar.gz"
download=$(mktemp -d "$RUNNER_TEMP/mnemoteca-download.XXXXXX")
base="https://github.com/RunWield/mnemoteca/releases/download/$tag"
curl --fail --location --retry 3 "$base/$asset" --output "$download/$asset"
curl --fail --location --retry 3 "$base/checksums.txt" --output "$download/checksums.txt"
checksum=$(awk -v asset="$asset" '$2 == asset || $2 == "*" asset { print $1 }' "$download/checksums.txt")
[[ "$checksum" =~ ^[0-9a-fA-F]{64}$ ]] || { echo "Missing or invalid checksum for $asset" >&2; exit 1; }
(cd "$download" && printf '%s  %s\n' "$checksum" "$asset" | shasum -a 256 --check)

bin="$RUNNER_TEMP/runwield-ci-bin"
mkdir -p "$bin"
tar -xzf "$download/$asset" -C "$bin" mnemoteca
"$bin/mnemoteca" --version
"$bin/mnemoteca" setup
