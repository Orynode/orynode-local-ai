#!/usr/bin/env bash

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME_ROOT="${PROJECT_ROOT}/.orynode"
TURBO_ROOT="${RUNTIME_ROOT}/turbo-fieldfare"
MODEL_ROOT="${RUNTIME_ROOT}/models/gemma4.gturbo"
PARTIAL_MODEL_ROOT="${MODEL_ROOT}.partial"
RESUME_STATE="${MODEL_ROOT}.resume.json"
TURBO_REPOSITORY="https://github.com/drumih/turbo-fieldfare.git"
TURBO_REVISION="${TURBO_FIELDFARE_REVISION:-f8abc4422e33a8808d5a5c1032a0e97ed5aa5118}"
SERVER_BIN="${TURBO_ROOT}/.build/release/TurboFieldfareServer"
REPACK_BIN="${TURBO_ROOT}/.build/release/TurboFieldfareRepack"

info() {
  printf '\n==> %s\n' "$1"
}

warn() {
  printf '\nWarning: %s\n' "$1" >&2
}

fail() {
  printf '\nError: %s\n' "$1" >&2
  if [[ -n "${2:-}" ]]; then
    printf '%s\n' "$2" >&2
  fi
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "$2"
}

available_kib() {
  df -Pk "$1" | awk 'NR == 2 { print $4 }'
}

require_free_space_gib() {
  local target="$1"
  local required_gib="$2"
  local available
  local required_kib
  mkdir -p "$target"
  available="$(available_kib "$target")"
  required_kib=$((required_gib * 1024 * 1024))
  if [[ -z "$available" || "$available" -lt "$required_kib" ]]; then
    fail \
      "Not enough free disk space." \
      "At least ${required_gib} GiB is required in ${target}."
  fi
}

acquire_lock() {
  local name="$1"
  INSTALL_LOCK="${RUNTIME_ROOT}/.${name}.lock"
  mkdir -p "${RUNTIME_ROOT}"
  if ! mkdir "${INSTALL_LOCK}" 2>/dev/null; then
    fail \
      "Another ${name} operation appears to be running." \
      "If no installer is running, remove ${INSTALL_LOCK} and try again."
  fi
  trap 'release_lock' EXIT
  trap 'release_lock; exit 130' INT
  trap 'release_lock; exit 143' TERM
}

release_lock() {
  if [[ -n "${INSTALL_LOCK:-}" && -d "${INSTALL_LOCK}" ]]; then
    rmdir "${INSTALL_LOCK}" 2>/dev/null || true
  fi
}

require_supported_mac() {
  if [[ "$(uname -s)" != "Darwin" || "$(uname -m)" != "arm64" ]]; then
    fail "Orynode Local AI currently requires an Apple Silicon Mac."
  fi

  local macos_major
  macos_major="$(sw_vers -productVersion | cut -d. -f1)"
  if [[ ! "${macos_major}" =~ ^[0-9]+$ || "${macos_major}" -lt 26 ]]; then
    fail \
      "macOS 26 or newer is required." \
      "Current version: $(sw_vers -productVersion)"
  fi
}

require_build_tools() {
  require_command git "Git is required. Install Xcode 26 or Apple's Command Line Tools."
  require_command swift "Swift is required. Install Xcode 26 or newer."
  require_command xcode-select "Xcode command-line tools are required."

  if ! xcode-select -p >/dev/null 2>&1; then
    fail "No active Xcode developer directory was found." "Open Xcode once, or run: sudo xcode-select --switch /Applications/Xcode.app"
  fi

  local swift_version
  swift_version="$(swift --version 2>&1 | awk 'NR == 1 { print $4 }')"
  local swift_major="${swift_version%%.*}"
  local swift_rest="${swift_version#*.}"
  local swift_minor="${swift_rest%%.*}"
  if [[ ! "${swift_major}" =~ ^[0-9]+$ || ! "${swift_minor}" =~ ^[0-9]+$ ]]; then
    fail "Unable to determine the installed Swift version."
  fi
  if (( swift_major < 6 || (swift_major == 6 && swift_minor < 2) )); then
    fail \
      "Swift 6.2 or newer is required." \
      "Current version: ${swift_version}"
  fi
}
