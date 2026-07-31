#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/lib/common.sh"

require_supported_mac

if [[ ! -x "${SERVER_BIN}" ]]; then
  fail "TurboFieldfare is not installed." "Run: npm run setup"
fi

if [[ ! -x "${REPACK_BIN}" ]]; then
  fail "The model verification tool is missing." "Run: npm run turbo:install"
fi

if [[ ! -f "${MODEL_ROOT}/manifest.json" ]]; then
  fail "The Gemma 4 model is not installed." "Run: npm run model:install"
fi

SETTINGS_FILE="${RUNTIME_ROOT}/runtime-settings.json"
DEFAULTS_FILE="${PROJECT_ROOT}/config/runtime-defaults.json"
APPLIED_FILE="${RUNTIME_ROOT}/turbo-applied.json"

MAX_CONTEXT="$(
  node --input-type=module -e "
import { readFileSync } from 'node:fs';
let allowed = new Set([4096, 8192, 16384, 32768, 65536]);
let value = 16384;
try {
  const defaults = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  if (Array.isArray(defaults.allowedMaxContext)) {
    allowed = new Set(defaults.allowedMaxContext);
  }
  if (allowed.has(Number(defaults.maxContext))) {
    value = Number(defaults.maxContext);
  }
} catch {}
try {
  const settings = JSON.parse(readFileSync(process.argv[1], 'utf8'));
  const next = Number(settings.maxContext);
  if (allowed.has(next)) value = next;
} catch {}
process.stdout.write(String(value));
" "${SETTINGS_FILE}" "${DEFAULTS_FILE}"
)"

has_max_context=false
for arg in "$@"; do
  if [[ "${arg}" == "--max-context" ]]; then
    has_max_context=true
    break
  fi
done

# Record what this process will apply so settings UI can detect mismatch.
mkdir -p "${RUNTIME_ROOT}"
node --input-type=module -e "
import { writeFileSync } from 'node:fs';
const maxContext = Number(process.argv[1]);
writeFileSync(process.argv[2], JSON.stringify({
  maxContext,
  startedAt: new Date().toISOString(),
  source: 'start-turbo.sh',
}, null, 2) + '\n');
" "${MAX_CONTEXT}" "${APPLIED_FILE}"

if [[ "${has_max_context}" == true ]]; then
  exec "${SERVER_BIN}" --model "${MODEL_ROOT}" "$@"
fi

info "Starting TurboFieldfare with max-context ${MAX_CONTEXT}"
exec "${SERVER_BIN}" \
  --model "${MODEL_ROOT}" \
  --max-context "${MAX_CONTEXT}" \
  "$@"
