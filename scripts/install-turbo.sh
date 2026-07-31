#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_supported_mac
require_build_tools
require_free_space_gib "${RUNTIME_ROOT}" 3
acquire_lock "turbo-install"

if [[ -e "${TURBO_ROOT}" && ! -d "${TURBO_ROOT}/.git" ]]; then
  fail \
    "The TurboFieldfare directory exists but is not a valid Git checkout." \
    "Move or remove ${TURBO_ROOT}, then try again."
fi

if [[ ! -d "${TURBO_ROOT}/.git" ]]; then
  info "Downloading TurboFieldfare"
  if ! git clone "${TURBO_REPOSITORY}" "${TURBO_ROOT}"; then
    fail "TurboFieldfare could not be downloaded." "Check the network connection, then run: npm run turbo:install"
  fi
fi

origin_url="$(git -C "${TURBO_ROOT}" remote get-url origin 2>/dev/null || true)"
if [[ "${origin_url}" != "${TURBO_REPOSITORY}" ]]; then
  fail \
    "The existing TurboFieldfare checkout has an unexpected origin." \
    "Expected ${TURBO_REPOSITORY}, found ${origin_url:-none}."
fi

current_revision="$(git -C "${TURBO_ROOT}" rev-parse HEAD 2>/dev/null || true)"
if [[ "${current_revision}" != "${TURBO_REVISION}" ]]; then
  info "Selecting the tested TurboFieldfare revision"
  if ! git -C "${TURBO_ROOT}" fetch --depth 1 origin "${TURBO_REVISION}"; then
    fail "The tested TurboFieldfare revision could not be downloaded." "Check the network connection and try again."
  fi
  if ! git -C "${TURBO_ROOT}" checkout --detach "${TURBO_REVISION}"; then
    fail "The tested TurboFieldfare revision could not be selected." "Do not modify files under .orynode/turbo-fieldfare."
  fi
else
  info "Using the already downloaded TurboFieldfare revision"
fi

info "Building the local inference server"
if ! swift build \
  --package-path "${TURBO_ROOT}" \
  -c release \
  --product TurboFieldfareServer; then
  fail "TurboFieldfareServer could not be built." "Review the Swift error above, then run: npm run turbo:install"
fi

info "Building the model installer"
if ! swift build \
  --package-path "${TURBO_ROOT}" \
  -c release \
  --product TurboFieldfareRepack; then
  fail "TurboFieldfareRepack could not be built." "Review the Swift error above, then run: npm run turbo:install"
fi

if [[ ! -x "${SERVER_BIN}" || ! -x "${REPACK_BIN}" ]]; then
  fail "The build finished without producing the required executables."
fi

info "TurboFieldfare is ready"
printf 'Next: npm run model:install\n'
