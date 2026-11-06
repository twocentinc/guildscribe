#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Guildscribe LaunchAgent removal is supported only on macOS." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this uninstaller as the macOS user, not as root." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
runtime_home="${GUILDSCRIBE_HOME:-$HOME/.guildscribe}"

cd "$project_root"

if [[ ! -f dist/index.js ]]; then
  echo "Guildscribe is not built. Run npm run build first." >&2
  exit 1
fi

exec node dist/index.js --home "$runtime_home" startup uninstall "$@"
