#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

if [[ ! -x "${REPACK_BIN}" ]]; then
  fail "The TurboFieldfare model maintenance tool is not installed."
fi

if [[ ! -e "${MODEL_ROOT}" && ! -e "${PARTIAL_MODEL_ROOT}" && ! -e "${RESUME_STATE}" ]]; then
  info "There is no model download state to reset"
  exit 0
fi

info "Removing the incomplete model download state"
"${REPACK_BIN}" --discard-partial --output "${MODEL_ROOT}"
info "The incomplete model state was removed"
