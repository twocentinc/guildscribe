#!/bin/bash
set -euo pipefail

if [[ "${EUID}" -eq 0 ]]; then
  echo "Guildscribe must be uninstalled as the logged-in user." >&2
  exit 1
fi

guildscribe startup uninstall
npm uninstall --global guildscribe
echo "Guildscribe runtime data remains at ${HOME}/.guildscribe"
