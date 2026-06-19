#!/usr/bin/env bash
# Thin wrapper around scripts/install-codex.js — installs the pr-replies skills
# for OpenAI Codex into ~/.agents/skills. Forwards any flags (e.g. --dry-run,
# --dir <path>). Requires Node.js 18+.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/install-codex.js" "$@"
