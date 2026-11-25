#!/usr/bin/env bash
set -euo pipefail
IFS= read -r -s -p 'Paste candidate token for one-time getMe check (hidden): ' TOKEN </dev/tty
printf '\n' >/dev/tty
trap 'unset TOKEN' EXIT
printf '%s' "$TOKEN" | node "$(dirname "${BASH_SOURCE[0]}")/diagnose-telegram-token.js"
unset TOKEN
trap - EXIT
