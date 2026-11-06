#!/bin/bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Guildscribe must be upgraded as the logged-in user." >&2
  exit 1
fi

npm install --global guildscribe@latest
guildscribe startup install
guildscribe version
