#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_supported_mac

info "Stopping TurboFieldfare on 127.0.0.1:8080 (if running)"
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:8080 -sTCP:LISTEN 2>/dev/null || true)"
  if [[ -n "${PIDS}" ]]; then
    # shellcheck disable=SC2086
    kill ${PIDS} 2>/dev/null || true
    sleep 1
  fi
fi

exec "${SCRIPT_DIR}/start-turbo.sh" "$@"
