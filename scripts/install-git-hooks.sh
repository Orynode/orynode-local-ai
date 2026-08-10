#!/usr/bin/env bash
# Install versioned hooks from .githooks into .git/hooks (no git config changes).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/.githooks"
dst="$root/.git/hooks"

if [[ ! -d "$root/.git" ]]; then
  echo "install-git-hooks: skip (not a git checkout)"
  exit 0
fi

if [[ ! -d "$src" ]]; then
  echo "install-git-hooks: missing $src" >&2
  exit 1
fi

mkdir -p "$dst"
installed=0
for hook in pre-commit commit-msg; do
  if [[ -f "$src/$hook" ]]; then
    chmod +x "$src/$hook"
    # Relative from .git/hooks → repo .githooks
    ln -sfn "../../.githooks/$hook" "$dst/$hook"
    installed=$((installed + 1))
  fi
done

echo "install-git-hooks: linked $installed hook(s) → .git/hooks"
