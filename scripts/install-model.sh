#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_supported_mac

if [[ ! -x "${REPACK_BIN}" ]]; then
  info "TurboFieldfare is missing; installing it first"
  bash "${PROJECT_ROOT}/scripts/install-turbo.sh"
fi

if [[ ! -x "${REPACK_BIN}" ]]; then
  fail "TurboFieldfare installation did not produce the model installer."
fi

acquire_lock "model-install"
mkdir -p "$(dirname "${MODEL_ROOT}")"
progress_pid=""

stop_progress() {
  if [[ -n "${progress_pid}" ]] && kill -0 "${progress_pid}" 2>/dev/null; then
    kill "${progress_pid}" 2>/dev/null || true
    wait "${progress_pid}" 2>/dev/null || true
  fi
  progress_pid=""
}

cleanup_model_install() {
  stop_progress
  release_lock
}

trap 'cleanup_model_install' EXIT
trap 'cleanup_model_install; exit 130' INT
trap 'cleanup_model_install; exit 143' TERM

if [[ -f "${MODEL_ROOT}/manifest.json" ]]; then
  info "Checking the existing model installation"
  if "${REPACK_BIN}" --verify-install --input-gturbo "${MODEL_ROOT}"; then
    info "Gemma 4 is already installed and verified"
    printf 'Start Orynode with: npm run local\n'
    exit 0
  fi
  fail \
    "The existing model installation failed verification." \
    "Run npm run model:reset, then run npm run model:install again."
fi

if [[ -f "${RESUME_STATE}" ]]; then
  require_free_space_gib "$(dirname "${MODEL_ROOT}")" 2
  info "Resuming the previous model download"
elif [[ -e "${MODEL_ROOT}" || -e "${PARTIAL_MODEL_ROOT}" ]]; then
  fail \
    "An incomplete model directory exists without resumable state." \
    "Run npm run model:reset, then run npm run model:install again."
else
  require_free_space_gib "$(dirname "${MODEL_ROOT}")" 16
  info "Starting a new Gemma 4 model download (about 15 GB)"
fi

printf 'The download can be resumed if it is interrupted.\n'
if [[ -z "${HF_TOKEN:-}" ]]; then
  printf 'No HF_TOKEN is set; public Hugging Face access will be used.\n'
fi
printf '\n'

node "${PROJECT_ROOT}/scripts/model-progress.mjs" &
progress_pid=$!

max_attempts="${ORYNODE_MODEL_DOWNLOAD_ATTEMPTS:-4}"
if [[ ! "${max_attempts}" =~ ^[1-9][0-9]*$ ]]; then
  fail "ORYNODE_MODEL_DOWNLOAD_ATTEMPTS must be a positive integer."
fi

attempt=1
install_succeeded=false
while (( attempt <= max_attempts )); do
  install_args=(
    --output "${MODEL_ROOT}"
    --overwrite
  )
  if [[ -f "${RESUME_STATE}" ]]; then
    install_args+=(--resume)
  fi

  if "${REPACK_BIN}" "${install_args[@]}"; then
    install_succeeded=true
    break
  fi

  if (( attempt == max_attempts )); then
    break
  fi

  case "${attempt}" in
    1) retry_delay=3 ;;
    2) retry_delay=10 ;;
    *) retry_delay=30 ;;
  esac
  warn "The download connection was interrupted (attempt ${attempt}/${max_attempts})."
  printf 'Retrying from the saved checkpoint in %s seconds...\n' "${retry_delay}" >&2
  sleep "${retry_delay}"
  attempt=$((attempt + 1))
done

if [[ "${install_succeeded}" != "true" ]]; then
  stop_progress
  warn "The model installation did not finish after ${max_attempts} attempts."
  if command -v scutil >/dev/null 2>&1 && scutil --proxy | grep -Eq '(HTTPSEnable|SOCKSEnable) : 1'; then
    printf 'A macOS HTTPS or SOCKS proxy is enabled. TLS errors may be caused by a local proxy or VPN.\n' >&2
    printf 'Restart the proxy/VPN, or bypass huggingface.co and *.hf.co, then retry.\n' >&2
  fi
  printf 'Run npm run model:install again to resume it.\n' >&2
  printf 'If resuming fails, run npm run model:reset and start again.\n' >&2
  exit 1
fi

stop_progress
info "Verifying the completed model"
if ! "${REPACK_BIN}" --verify-install --input-gturbo "${MODEL_ROOT}"; then
  fail \
    "The downloaded model failed verification." \
    "Run npm run model:reset, then run npm run model:install again."
fi

info "The model is installed and verified"
printf 'Start Orynode with: npm run local\n'
