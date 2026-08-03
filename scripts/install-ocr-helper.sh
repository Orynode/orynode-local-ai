#!/usr/bin/env bash
# 编译 Apple Vision OCR helper 并安装到 .orynode/bin/orynode-ocr
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

if [[ "$(uname -s)" != "Darwin" ]]; then
  info "Skipping OCR helper build on non-macOS"
  exit 0
fi

if ! command -v swift >/dev/null 2>&1; then
  fail "swift is required to build orynode-ocr"
fi

PKG_DIR="${PROJECT_ROOT}/native/macos/orynode-ocr"
BIN_DIR="${PROJECT_ROOT}/.orynode/bin"
mkdir -p "${BIN_DIR}"

info "Building orynode-ocr (Apple Vision helper)"
(
  cd "${PKG_DIR}"
  swift build -c release --product orynode-ocr
)

BUILT="${PKG_DIR}/.build/release/orynode-ocr"
if [[ ! -x "${BUILT}" ]]; then
  fail "orynode-ocr build did not produce executable"
fi

cp -f "${BUILT}" "${BIN_DIR}/orynode-ocr"
chmod +x "${BIN_DIR}/orynode-ocr"

info "Probing OCR helper capabilities"
CAP_JSON="$("${BIN_DIR}/orynode-ocr" --capabilities | head -n 1)"
if ! printf '%s' "${CAP_JSON}" | grep -q '"available"[[:space:]]*:[[:space:]]*true'; then
  fail "orynode-ocr --capabilities did not report available=true: ${CAP_JSON}"
fi

info "OCR helper installed at ${BIN_DIR}/orynode-ocr"
