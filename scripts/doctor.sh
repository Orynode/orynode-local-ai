#!/usr/bin/env bash
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

problems=0

check() {
  local label="$1"
  local value="$2"
  local ok="$3"
  if [[ "$ok" == "yes" ]]; then
    printf '✓ %-22s %s\n' "$label" "$value"
  else
    printf '✗ %-22s %s\n' "$label" "$value"
    problems=$((problems + 1))
  fi
}

printf 'Orynode Local AI diagnostics\n'
printf 'Project: %s\n\n' "${PROJECT_ROOT}"

if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
  check "Hardware" "Apple Silicon" "yes"
else
  check "Hardware" "$(uname -s) $(uname -m)" "no"
fi

if command -v sw_vers >/dev/null 2>&1; then
  macos_version="$(sw_vers -productVersion)"
  macos_major="${macos_version%%.*}"
  if [[ "${macos_major}" =~ ^[0-9]+$ && "${macos_major}" -ge 26 ]]; then
    check "macOS" "${macos_version}" "yes"
  else
    check "macOS" "${macos_version} (26 or newer required)" "no"
  fi
else
  check "macOS" "not detected" "no"
fi

for tool in node npm git swift; do
  if command -v "${tool}" >/dev/null 2>&1; then
    version="$("${tool}" --version 2>/dev/null | head -n 1)"
    check "${tool}" "${version}" "yes"
  else
    check "${tool}" "not installed" "no"
  fi
done

free_kib="$(available_kib "${PROJECT_ROOT}")"
free_gib=$((free_kib / 1024 / 1024))
if [[ "${free_gib}" -ge 16 || -f "${MODEL_ROOT}/manifest.json" ]]; then
  check "Free disk space" "${free_gib} GiB" "yes"
else
  check "Free disk space" "${free_gib} GiB (16 GiB required)" "no"
fi

if [[ -x "${SERVER_BIN}" && -x "${REPACK_BIN}" ]]; then
  check "TurboFieldfare" "installed" "yes"
else
  check "TurboFieldfare" "not installed; run npm run turbo:install" "no"
fi

if [[ -f "${MODEL_ROOT}/manifest.json" ]]; then
  check "Gemma 4 model" "installed" "yes"
elif [[ -f "${RESUME_STATE}" || -e "${PARTIAL_MODEL_ROOT}" ]]; then
  check "Gemma 4 model" "partial download; run npm run model:install" "no"
else
  check "Gemma 4 model" "not installed; run npm run model:install" "no"
fi

if command -v curl >/dev/null 2>&1 &&
  curl --silent --fail --max-time 1 http://127.0.0.1:8080/health >/dev/null 2>&1; then
  check "Local model service" "running at 127.0.0.1:8080" "yes"
else
  check "Local model service" "not running" "no"
fi

if command -v curl >/dev/null 2>&1 &&
  curl --silent --fail --max-time 1 http://127.0.0.1:4318/health >/dev/null 2>&1; then
  check "Local data service" "running at 127.0.0.1:4318" "yes"
elif [[ -f "${RUNTIME_ROOT}/data/orynode.db" ]]; then
  check "Conversation database" "created; data service not running" "no"
else
  check "Conversation database" "not created yet" "no"
fi

printf '\n'
if [[ "${problems}" -eq 0 ]]; then
  printf 'Everything required by Orynode is ready.\n'
  exit 0
fi

printf '%s item(s) need attention. See docs/TROUBLESHOOTING_zh-CN.md.\n' "${problems}"
exit 1
