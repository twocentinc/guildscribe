#!/bin/bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Guildscribe LaunchAgent installation is supported only on macOS." >&2
  exit 1
fi

if [[ "$(id -u)" -eq 0 ]]; then
  echo "Run this installer as the macOS user, not as root." >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/.." && pwd)"
runtime_home="${GUILDSCRIBE_HOME:-$HOME/.guildscribe}"

cd "$project_root"

if [[ -d src && -f tsconfig.json ]]; then
  if [[ ! -d node_modules ]]; then
    echo "Dependencies are missing. Run npm install first." >&2
    exit 1
  fi
  npm run build
elif [[ ! -f dist/index.js ]]; then
  echo "Guildscribe's compiled CLI is missing." >&2
  exit 1
fi

exec node dist/index.js --home "$runtime_home" startup install "$@"
