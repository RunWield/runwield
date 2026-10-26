#!/usr/bin/env bash
set -euo pipefail

REPO="${WLD_REPO:-gandazgul/runwield}"
MNEMOTECA_REPO="${WLD_MNEMOTECA_REPO:-RunWield/mnemoteca}"
MNEMOTECA_INSTALLER_URL="${WLD_MNEMOTECA_INSTALLER_URL:-https://raw.githubusercontent.com/${MNEMOTECA_REPO}/main/install.sh}"
CYMBAL_REPO="${WLD_CYMBAL_REPO:-1broseidon/cymbal}"
KETCH_REPO="${WLD_KETCH_REPO:-1broseidon/ketch}"
SNIP_REPO="${WLD_SNIP_REPO:-edouard-claude/snip}"
REQUESTED_VERSION="${1:-}"

need_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "[wld installer] Missing required command: $1" >&2
    exit 1
  fi
}

need_cmd curl
need_cmd tar
need_cmd install

expand_path() {
  case "$1" in
    "~")
      if [[ -z "${HOME:-}" ]]; then
        echo "[wld installer] HOME is not set. Set WLD_INSTALL_DIR to an absolute writable bin directory." >&2
        exit 1
      fi
      echo "$HOME"
      ;;
    "~/"*)
      if [[ -z "${HOME:-}" ]]; then
        echo "[wld installer] HOME is not set. Set WLD_INSTALL_DIR to an absolute writable bin directory." >&2
        exit 1
      fi
      echo "${HOME}/${1#~/}"
      ;;
    *) echo "$1" ;;
  esac
}

resolve_install_dir() {
  if [[ -n "${WLD_INSTALL_DIR:-}" ]]; then
    expand_path "$WLD_INSTALL_DIR"
    return
  fi

  if [[ -z "${HOME:-}" ]]; then
    echo "[wld installer] HOME is not set. Set WLD_INSTALL_DIR to a writable bin directory." >&2
    exit 1
  fi

  echo "${HOME}/.local/bin"
}

sha_verify() {
  local checksums_file="$1"
  local asset_name="$2"
  local check_line

  check_line="$(awk -v asset="$asset_name" '$2 == asset { print; exit }' "$checksums_file")"
  if [[ -z "$check_line" ]]; then
    echo "[wld installer] Checksum manifest lacks an entry for ${asset_name}." >&2
    return 2
  fi

  if command -v sha256sum >/dev/null 2>&1; then
    (cd "$(dirname "$checksums_file")" && printf '%s\n' "$check_line" | sha256sum -c -)
    return
  fi

  if command -v shasum >/dev/null 2>&1; then
    (cd "$(dirname "$checksums_file")" && printf '%s\n' "$check_line" | shasum -a 256 -c -)
    return
  fi

  echo "[wld installer] Missing checksum tool (sha256sum or shasum)." >&2
  return 1
}

latest_tag_for_repo() {
  local repo="$1"
  local api_url="https://api.github.com/repos/${repo}/releases/latest"
  local web_url="https://github.com/${repo}/releases/latest"
  local tag effective_url

  tag="$(curl -fsSL "$api_url" 2>/dev/null | awk '
    /"tag_name"[[:space:]]*:/ {
      line = $0
      sub(/^.*"tag_name"[[:space:]]*:[[:space:]]*"/, "", line)
      sub(/".*$/, "", line)
      print line
      exit
    }
  ' || true)"
  if [[ -n "$tag" ]]; then
    echo "$tag"
    return 0
  fi

  effective_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$web_url" || true)"
  tag="${effective_url##*/}"
  if [[ "$effective_url" == */releases/tag/* && -n "$tag" && "$tag" != "latest" ]]; then
    echo "$tag"
    return 0
  fi

  echo "[wld installer] Could not determine latest release tag from ${api_url} or ${web_url}" >&2
  return 1
}

release_asset_sha256() {
  local repo="$1"
  local version="$2"
  local asset_name="$3"
  local api_url="https://api.github.com/repos/${repo}/releases/tags/${version}"
  local web_url="https://github.com/${repo}/releases/expanded_assets/${version}"
  local digest

  digest="$(curl -fsSL "$api_url" 2>/dev/null | awk -v asset="$asset_name" '
    index($0, "\"name\": \"" asset "\"") { found = 1 }
    found && /\"digest\"[[:space:]]*:/ {
      line = $0
      sub(/^.*\"digest\"[[:space:]]*:[[:space:]]*\"/, "", line)
      sub(/\".*$/, "", line)
      if (line ~ /^sha256:[0-9a-fA-F]{64}$/) {
        sub(/^sha256:/, "", line)
        print line
        exit
      }
    }
  ' || true)"
  if [[ -n "$digest" ]]; then
    echo "$digest"
    return 0
  fi

  digest="$(curl -fsSL "$web_url" | awk -v asset="$asset_name" '
    index($0, asset) { found = 1 }
    found && /clipboard-button-sha256:[0-9a-fA-F]{64}/ {
      line = $0
      sub(/^.*clipboard-button-sha256:/, "", line)
      sub(/[^0-9a-fA-F].*$/, "", line)
      print line
      exit
    }
  ' || true)"
  if [[ -n "$digest" ]]; then
    echo "$digest"
    return 0
  fi

  echo "[wld installer] Could not find a SHA-256 release asset digest for ${asset_name} in ${repo} ${version}." >&2
  return 1
}

sha_verify_asset_digest() {
  local repo="$1"
  local version="$2"
  local asset_name="$3"
  local archive_path="$4"
  local digest digest_file

  digest="$(release_asset_sha256 "$repo" "$version" "$asset_name")" || return 1
  digest_file="${archive_path}.sha256"
  printf '%s  %s\n' "$digest" "$asset_name" >"$digest_file"
  echo "[wld installer] Using GitHub release asset digest for ${asset_name}."
  sha_verify "$digest_file" "$asset_name"
}

resolve_version() {
  if [[ -n "$REQUESTED_VERSION" ]]; then
    echo "$REQUESTED_VERSION"
    return
  fi

  latest_tag_for_repo "$REPO"
}

resolve_platform() {
  local raw_os raw_arch
  raw_os="${WLD_TEST_UNAME_S:-$(uname -s)}"
  raw_arch="${WLD_TEST_UNAME_M:-$(uname -m)}"

  case "$raw_os" in
    Darwin) WLD_OS="darwin" ;;
    Linux) WLD_OS="linux" ;;
    *)
      echo "[wld installer] Unsupported OS: ${raw_os} (installer currently supports macOS/Linux)" >&2
      exit 1
      ;;
  esac

  case "$raw_arch" in
    x86_64|amd64) WLD_ARCH="amd64" ;;
    arm64|aarch64) WLD_ARCH="arm64" ;;
    *)
      echo "[wld installer] Unsupported ${WLD_OS} architecture: ${raw_arch}" >&2
      exit 1
      ;;
  esac
}

wld_asset_suffix() {
  local wld_arch="$WLD_ARCH"
  [[ "$wld_arch" == "amd64" ]] && wld_arch="x64"
  echo "${WLD_OS}-${wld_arch}"
}

helper_asset_name() {
  local helper="$1"
  local version="$2"
  local version_no_v="${version#v}"
  local arch="$WLD_ARCH"

  case "$helper" in
    cymbal)
      [[ "$arch" == "amd64" ]] && arch="x86_64"
      echo "cymbal_${version}_${WLD_OS}_${arch}.tar.gz"
      ;;
    ketch)
      [[ "$arch" == "amd64" ]] && arch="x86_64"
      echo "ketch_${version_no_v}_${WLD_OS}_${arch}.tar.gz"
      ;;
    snip) echo "snip_${version_no_v}_${WLD_OS}_${arch}.tar.gz" ;;
    *)
      echo "[wld installer] Unknown helper: ${helper}" >&2
      return 1
      ;;
  esac
}

shell_config_file() {
  local current_shell
  current_shell="$(basename "${SHELL:-sh}")"

  case "$current_shell" in
    fish) echo "${HOME}/.config/fish/config.fish" ;;
    zsh) echo "${ZDOTDIR:-$HOME}/.zshrc" ;;
    bash)
      if [[ -f "${HOME}/.bashrc" ]]; then
        echo "${HOME}/.bashrc"
      else
        echo "${HOME}/.profile"
      fi
      ;;
    *) echo "${HOME}/.profile" ;;
  esac
}

path_update_command() {
  local bin_dir="$1"
  local current_shell bin_expr home_dir
  current_shell="$(basename "${SHELL:-sh}")"
  home_dir="${HOME:-}"

  if [[ -n "$home_dir" && "$bin_dir" == "${home_dir}/.local/bin" ]]; then
    bin_expr='$HOME/.local/bin'
  else
    bin_expr="$bin_dir"
  fi

  case "$current_shell" in
    fish) echo "fish_add_path \"${bin_expr}\"" ;;
    *) echo "export PATH=\"${bin_expr}:\$PATH\"" ;;
  esac
}

config_file_mentions_path() {
  local config_file="$1"
  local command="$2"

  [[ -f "$config_file" ]] || return 1
  grep -Fxq "$command" "$config_file"
}

prompt_add_path_to_profile() {
  local bin_dir="$1"
  local config_file command answer

  [[ -n "${HOME:-}" ]] || return 1
  [[ "${WLD_NONINTERACTIVE:-}" != "1" ]] || return 1
  ( : <>/dev/tty ) 2>/dev/null || return 1

  config_file="$(shell_config_file)"
  command="$(path_update_command "$bin_dir")"

  if config_file_mentions_path "$config_file" "$command"; then
    echo "[wld installer] A PATH update for ${bin_dir} already exists in ${config_file}."
    return 0
  fi

  exec 3<>/dev/tty
  printf "[wld installer] Add %s to your PATH in %s now? [Y/n] " "$bin_dir" "$config_file" >&3
  if ! IFS= read -r answer <&3; then
    answer=
  fi
  exec 3>&-

  case "$answer" in
    n|N|no|NO) return 1 ;;
    *) ;;
  esac

  mkdir -p "$(dirname "$config_file")"
  touch "$config_file"
  printf '\n# RunWield\n%s\n' "$command" >> "$config_file"
  echo "[wld installer] Added ${bin_dir} to ${config_file}."
}

installed_wld_is_first_on_path() {
  local installed_path active_path
  installed_path="${INSTALL_DIR}/wld"
  active_path="$(command -v wld 2>/dev/null || true)"

  [[ -n "$active_path" ]] && [[ "$active_path" == "$installed_path" ]]
}

print_path_message() {
  local active_path command
  active_path="$(command -v wld 2>/dev/null || true)"

  echo "[wld installer] RunWield binaries were installed, but your shell may not use that install yet."
  if [[ -n "$active_path" && "$active_path" != "${INSTALL_DIR}/wld" ]]; then
    echo "[wld installer] Your shell currently resolves wld to: ${active_path}"
  fi

  prompt_add_path_to_profile "$INSTALL_DIR" || true
  command="$(path_update_command "$INSTALL_DIR")"
  echo "[wld installer] Restart your shell or run:"
  echo
  echo "  ${command}"
  echo
  echo "[wld installer] Then run: wld --help"
}

helper_existing_path() {
  local name="$1"
  local found
  found="$(command -v "$name" 2>/dev/null || true)"
  if [[ -n "$found" ]]; then
    echo "$found"
    return 0
  fi
  if [[ -x "${INSTALL_DIR}/${name}" ]]; then
    echo "${INSTALL_DIR}/${name}"
    return 0
  fi
  return 1
}

download() {
  local url="$1"
  local output="$2"
  curl -fL "$url" -o "$output"
}

extract_archive() {
  local archive="$1"
  local dest="$2"
  case "$archive" in
    *.tar.gz) tar -xzf "$archive" -C "$dest" ;;
    *.tar.zst) zstd -dc "$archive" | tar -xf - -C "$dest" ;;
    *)
      echo "[wld installer] Unsupported archive format: ${archive}" >&2
      return 1
      ;;
  esac
}

find_executable() {
  local root="$1"
  local exe="$2"
  find "$root" -type f -name "$exe" -perm -u+x | head -n 1
}

install_mnemoteca() {
  local existing work_dir installer_path

  if existing="$(helper_existing_path mnemoteca)"; then
    PRESERVED_HELPERS+=("mnemoteca:${existing}")
    echo "[wld installer] Preserving existing mnemoteca: ${existing}"
    return 0
  fi

  work_dir="${TMP_DIR}/mnemoteca-installer"
  mkdir -p "$work_dir"
  installer_path="${work_dir}/install.sh"

  echo "[wld installer] Installing mnemoteca with the official Mnemoteca installer ..."
  if ! download "$MNEMOTECA_INSTALLER_URL" "$installer_path"; then
    echo "[wld installer] Failed to download Mnemoteca installer from ${MNEMOTECA_INSTALLER_URL}." >&2
    return 1
  fi
  chmod 700 "$installer_path"

  if ! INSTALL_DIR="$INSTALL_DIR" MNEMOTECA_REPO="$MNEMOTECA_REPO" "$installer_path"; then
    echo "[wld installer] Mnemoteca installer failed." >&2
    return 1
  fi
  if [[ ! -x "${INSTALL_DIR}/mnemoteca" ]]; then
    echo "[wld installer] Mnemoteca installer completed but did not produce executable '${INSTALL_DIR}/mnemoteca'." >&2
    return 1
  fi

  INSTALLED_HELPERS+=("mnemoteca:${INSTALL_DIR}/mnemoteca")
  echo "[wld installer] Installed mnemoteca to ${INSTALL_DIR}/mnemoteca"
}

install_helper() {
  local name="$1"
  local repo="$2"
  local required="$3"
  local existing version asset base_url work_dir checksums source_path verify_status

  if existing="$(helper_existing_path "$name")"; then
    PRESERVED_HELPERS+=("${name}:${existing}")
    echo "[wld installer] Preserving existing ${name}: ${existing}"
    return 0
  fi

  version="$(latest_tag_for_repo "$repo")"
  asset="$(helper_asset_name "$name" "$version")"
  base_url="https://github.com/${repo}/releases/download/${version}"
  work_dir="${TMP_DIR}/${name}"
  mkdir -p "$work_dir"

  echo "[wld installer] Installing ${name} ${version} (${asset}) ..."
  if ! download "${base_url}/checksums.txt" "${work_dir}/checksums.txt"; then
    echo "[wld installer] Failed to download ${name} checksums from ${repo}." >&2
    [[ "$required" == "required" ]] && return 1 || return 2
  fi
  if ! download "${base_url}/${asset}" "${work_dir}/${asset}"; then
    echo "[wld installer] Failed to download ${name} archive ${asset}." >&2
    [[ "$required" == "required" ]] && return 1 || return 2
  fi
  if sha_verify "${work_dir}/checksums.txt" "$asset"; then
    :
  else
    verify_status=$?
    if [[ "$verify_status" == "2" ]]; then
      if ! sha_verify_asset_digest "$repo" "$version" "$asset" "${work_dir}/${asset}"; then
        echo "[wld installer] Checksum verification failed for ${name} asset ${asset}." >&2
        [[ "$required" == "required" ]] && return 1 || return 2
      fi
    else
      echo "[wld installer] Checksum verification failed for ${name} asset ${asset}." >&2
      [[ "$required" == "required" ]] && return 1 || return 2
    fi
  fi
  if ! extract_archive "${work_dir}/${asset}" "$work_dir"; then
    echo "[wld installer] Failed to extract ${name} archive ${asset}." >&2
    [[ "$required" == "required" ]] && return 1 || return 2
  fi

  source_path="$(find_executable "$work_dir" "$name")"
  if [[ -z "$source_path" ]]; then
    echo "[wld installer] Extracted ${name} archive does not contain executable '${name}'." >&2
    [[ "$required" == "required" ]] && return 1 || return 2
  fi

  install -m 755 "$source_path" "${INSTALL_DIR}/${name}"
  INSTALLED_HELPERS+=("${name}:${INSTALL_DIR}/${name}")
  echo "[wld installer] Installed ${name} to ${INSTALL_DIR}/${name}"
}

install_agent_browser() {
  local name="agent-browser"
  local existing npm_prefix npm_bin wrapper_path

  if existing="$(helper_existing_path "$name")"; then
    PRESERVED_HELPERS+=("${name}:${existing}")
    echo "[wld installer] Preserving existing ${name}: ${existing}"
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    echo "[wld installer] Missing npm, which is required to install agent-browser." >&2
    return 1
  fi

  npm_prefix="${INSTALL_DIR}/.agent-browser-npm"
  npm_bin="${npm_prefix}/bin/agent-browser"
  wrapper_path="${INSTALL_DIR}/agent-browser"
  mkdir -p "$npm_prefix"

  echo "[wld installer] Installing agent-browser with npm ..."
  if ! npm install --global --prefix "$npm_prefix" agent-browser; then
    echo "[wld installer] Failed to install agent-browser with npm." >&2
    return 1
  fi

  if [[ ! -x "$npm_bin" ]]; then
    echo "[wld installer] npm installation did not produce executable '${npm_bin}'." >&2
    return 1
  fi

  cat >"$wrapper_path" <<EOF
#!/usr/bin/env bash
exec "${npm_bin}" "\$@"
EOF
  chmod 755 "$wrapper_path"
  INSTALLED_HELPERS+=("${name}:${wrapper_path}")
  echo "[wld installer] Installed agent-browser to ${wrapper_path}"
}

prompt_install_snip_filters() {
  local wld_bin snip_bin answer
  wld_bin="${INSTALL_DIR}/wld"
  snip_bin="$(command -v snip 2>/dev/null || true)"
  [[ -n "$snip_bin" ]] || snip_bin="${INSTALL_DIR}/snip"

  [[ -n "${HOME:-}" ]] || return 0
  [[ -x "$wld_bin" ]] || return 0
  [[ -x "$snip_bin" ]] || return 0
  [[ "${WLD_NONINTERACTIVE:-}" != "1" ]] || return 0

  # Skip only when all current RunWield filters are installed. Old Harns files
  # must go through the install command so it can replace and remove them.
  if [[ -f "${HOME}/.config/snip/filters/deno-check.yaml" ]] &&
     [[ -f "${HOME}/.config/snip/filters/deno-fmt.yaml" ]] &&
     [[ -f "${HOME}/.config/snip/filters/deno-lint.yaml" ]] &&
     [[ -f "${HOME}/.config/snip/filters/deno-test.yaml" ]] &&
     grep -q '^# Managed by RunWield\.' "${HOME}/.config/snip/filters/deno-check.yaml" &&
     grep -q '^# Managed by RunWield\.' "${HOME}/.config/snip/filters/deno-fmt.yaml" &&
     grep -q '^# Managed by RunWield\.' "${HOME}/.config/snip/filters/deno-lint.yaml" &&
     grep -q '^# Managed by RunWield\.' "${HOME}/.config/snip/filters/deno-test.yaml"; then
    echo "[wld installer] RunWield snip filters already installed in ${HOME}/.config/snip/filters."
    return 0
  fi
  if ( : <>/dev/tty ) 2>/dev/null; then
    exec 3<>/dev/tty
    printf "[wld installer] Install RunWield Deno Snip filters into ~/.config/snip/filters for plain snip commands? [Y/n] " >&3
    if ! IFS= read -r answer <&3; then
      answer=
    fi
    exec 3>&-
  else
    printf "[wld installer] Install RunWield Deno Snip filters into ~/.config/snip/filters for plain snip commands? [Y/n] "
    if ! IFS= read -r answer; then
      answer=
    fi
  fi

  case "$answer" in
    n|N|no|NO)
      echo "[wld installer] Skipped Snip filter install. You can run: wld snip-filters install"
      return 0
      ;;
    *) ;;
  esac

  if PATH="${INSTALL_DIR}:$PATH" "$wld_bin" snip-filters install; then
    echo "[wld installer] RunWield Deno Snip filters installed."
    echo "[wld installer] To remove them later, run: wld snip-filters cleanup"
  else
    echo "[wld installer] Snip filter install failed. You can retry with: wld snip-filters install" >&2
  fi
}

INSTALL_DIR="$(resolve_install_dir)"
VERSION="$(resolve_version)"
resolve_platform
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
INSTALLED_HELPERS=()
PRESERVED_HELPERS=()

mkdir -p "$INSTALL_DIR"
if [[ ! -w "$INSTALL_DIR" ]]; then
  echo "[wld installer] No write permission to ${INSTALL_DIR}." >&2
  echo "[wld installer] Choose a user-writable location with WLD_INSTALL_DIR, for example:" >&2
  echo "[wld installer]   WLD_INSTALL_DIR=\"${HOME:-$PWD}/.local/bin\" bash install.sh" >&2
  exit 1
fi

SUFFIX="$(wld_asset_suffix)"
BASE_URL="https://github.com/${REPO}/releases/download/${VERSION}"
ASSET_BASE="wld-${VERSION}-${SUFFIX}"
ASSET="${ASSET_BASE}.tar.gz"
ARCHIVE_FORMAT="gzip"
if command -v zstd >/dev/null 2>&1; then
  ASSET="${ASSET_BASE}.tar.zst"
  ARCHIVE_FORMAT="zstd"
fi

echo "[wld installer] Installing ${ASSET} from ${REPO} ..."
if ! download "${BASE_URL}/${ASSET}" "${TMP_DIR}/${ASSET}"; then
  if [[ "$ARCHIVE_FORMAT" != "zstd" ]]; then
    exit 1
  fi
  echo "[wld installer] Zstandard archive unavailable; falling back to gzip."
  ASSET="${ASSET_BASE}.tar.gz"
  ARCHIVE_FORMAT="gzip"
  download "${BASE_URL}/${ASSET}" "${TMP_DIR}/${ASSET}"
fi
download "${BASE_URL}/SHA256SUMS" "${TMP_DIR}/SHA256SUMS"
if ! sha_verify "${TMP_DIR}/SHA256SUMS" "$ASSET"; then
  echo "[wld installer] Published checksum manifest did not match ${ASSET}; checking GitHub's release asset digest." >&2
  if ! sha_verify_asset_digest "$REPO" "$VERSION" "$ASSET" "${TMP_DIR}/${ASSET}"; then
    echo "[wld installer] Checksum verification failed for ${ASSET}." >&2
    exit 1
  fi
fi
extract_archive "${TMP_DIR}/${ASSET}" "$TMP_DIR"

if [[ ! -x "${TMP_DIR}/wld" ]]; then
  echo "[wld installer] Extracted archive does not contain executable 'wld'." >&2
  exit 1
fi

install -m 755 "${TMP_DIR}/wld" "${INSTALL_DIR}/wld"
echo "[wld installer] Installed wld to ${INSTALL_DIR}/wld"

if ! install_mnemoteca; then
  echo "[wld installer] Required helper Mnemoteca could not be installed. Rerun this installer after fixing the error above." >&2
  exit 1
fi
if ! install_helper cymbal "$CYMBAL_REPO" required; then
  echo "[wld installer] Required helper Cymbal could not be installed. Rerun this installer after fixing the error above." >&2
  exit 1
fi
if ! install_helper ketch "$KETCH_REPO" required; then
  echo "[wld installer] Required helper Ketch could not be installed. Rerun this installer after fixing the error above." >&2
  exit 1
fi
if ! install_agent_browser; then
  echo "[wld installer] Required helper agent-browser could not be installed. Rerun this installer after fixing the error above." >&2
  exit 1
fi
if ! install_helper snip "$SNIP_REPO" optional; then
  echo "[wld installer] Warning: optional helper Snip could not be installed. RunWield will work, but command output compression/filter integration may be unavailable." >&2
fi

if ((${#INSTALLED_HELPERS[@]})); then
  echo "[wld installer] Installed helpers: ${INSTALLED_HELPERS[*]}"
fi
if ((${#PRESERVED_HELPERS[@]})); then
  echo "[wld installer] Preserved helpers: ${PRESERVED_HELPERS[*]}"
fi

echo "[wld installer] ✅ RunWield installation complete in ${INSTALL_DIR}"
prompt_install_snip_filters
if installed_wld_is_first_on_path; then
  echo "[wld installer] Run: wld --help"
else
  print_path_message
fi
