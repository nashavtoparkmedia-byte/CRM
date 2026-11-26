#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${REPO_DIR}/deploy/secrets"
TARGET_FILE="${TARGET_DIR}/telegram-bot.env"
umask 077
install -d -m 0700 "${TARGET_DIR}"

IFS= read -r -s -p 'Enter the newly rotated @yoko_park_bot token (input hidden): ' BOT_TOKEN </dev/tty
printf '\n' >/dev/tty
if [[ ! "${BOT_TOKEN}" =~ ^[0-9]{6,}:[A-Za-z0-9_-]{20,}$ ]]; then
    unset BOT_TOKEN
    printf '%s\n' 'Rejected: token format invalid; no value was stored.' >&2
    exit 1
fi

TMP_FILE="$(mktemp "${TARGET_DIR}/.telegram-bot.env.XXXXXX")"
trap 'rm -f "${TMP_FILE}"; unset BOT_TOKEN' EXIT
if [[ -f "${TARGET_FILE}" ]]; then
    while IFS= read -r LINE || [[ -n "${LINE}" ]]; do
        [[ "${LINE}" == BOT_TOKEN=* ]] && continue
        printf '%s\n' "${LINE}" >>"${TMP_FILE}"
    done <"${TARGET_FILE}"
fi
unset LINE
printf 'BOT_TOKEN=%s\n' "${BOT_TOKEN}" >>"${TMP_FILE}"
chmod 0600 "${TMP_FILE}"
mv -f -- "${TMP_FILE}" "${TARGET_FILE}"
unset BOT_TOKEN
trap - EXIT
printf '%s\n' 'Stored BOT_TOKEN; preserved other entries in deploy/secrets/telegram-bot.env (mode 0600).'
