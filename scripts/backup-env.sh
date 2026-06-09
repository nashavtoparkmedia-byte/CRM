#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-env.sh — шифрование .env и конфигов через age, заливка в S3
#
# Запускать ПОСЛЕ КАЖДОГО ИЗМЕНЕНИЯ секретов:
#   bash scripts/backup-env.sh
#
# Можно также повесить на cron раз в неделю как страховку (на случай если
# ты забыл вручную):
#   0 4 * * 0 cd /opt/crm && bash scripts/backup-env.sh >> /var/log/crm-backup-env.log 2>&1
#
# Что бэкапит (всё что чувствительное и НЕ в git):
#   - .env.production
#   - deploy/nginx/*.conf
#   - /etc/xray/config.json (если есть)
#   - /etc/freeswitch/ (конфиги SIP)
#   - rclone.conf
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

log() { printf "\033[1;34m[backup-env]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

# Подгрузить значения для S3 remote
[ -f .env.production ] && { set -a; . .env.production; set +a; }
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"

# ─── 1. Проверка age public key ──────────────────────────────────────────────
AGE_PUBKEY_FILE="deploy/secrets/age-public.key"
[ -f "${AGE_PUBKEY_FILE}" ] || fail "Нет ${AGE_PUBKEY_FILE} — нечем шифровать. См. docs/SECRETS.md, раздел 1"

AGE_PUBKEY=$(grep -E '^age1' "${AGE_PUBKEY_FILE}" | head -1)
[ -n "${AGE_PUBKEY}" ] || fail "В ${AGE_PUBKEY_FILE} нет age1... ключа"

log "Recipient: ${AGE_PUBKEY:0:20}..."

# ─── 2. Собираем чувствительные файлы ────────────────────────────────────────
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR=$(mktemp -d)
trap "rm -rf '${WORK_DIR}'" EXIT
STAGE="${WORK_DIR}/env-${STAMP}"
mkdir -p "${STAGE}"

# .env.production
if [ -f .env.production ]; then
    cp .env.production "${STAGE}/.env.production"
    log "  + .env.production"
fi

# .env по сервисам (на dev-машине, на VPS их не будет — это норм)
for SVC in gravity-mvp tg-bot yandex-fleet-scraper max-web-scraper avito-worker; do
    if [ -f "${SVC}/.env" ]; then
        mkdir -p "${STAGE}/${SVC}"
        cp "${SVC}/.env" "${STAGE}/${SVC}/.env"
        log "  + ${SVC}/.env"
    fi
done

# nginx
if [ -d deploy/nginx ]; then
    cp -r deploy/nginx "${STAGE}/nginx"
    log "  + deploy/nginx/"
fi

# Системные конфиги (только если запущено от root или с sudo)
for SYS in /etc/xray/config.json /etc/coturn/turnserver.conf; do
    if [ -r "${SYS}" ]; then
        mkdir -p "${STAGE}/system$(dirname "${SYS}")"
        cp "${SYS}" "${STAGE}/system${SYS}"
        log "  + ${SYS}"
    fi
done

# FreeSWITCH конфиги (целый каталог)
if [ -d /etc/freeswitch ] && [ -r /etc/freeswitch ]; then
    mkdir -p "${STAGE}/system/etc"
    cp -r /etc/freeswitch "${STAGE}/system/etc/freeswitch" 2>/dev/null || \
        log "  ! /etc/freeswitch — нужны права root, пропуск"
fi

# rclone config
RCLONE_CONF="${HOME}/.config/rclone/rclone.conf"
if [ -f "${RCLONE_CONF}" ]; then
    mkdir -p "${STAGE}/rclone"
    cp "${RCLONE_CONF}" "${STAGE}/rclone/rclone.conf"
    log "  + rclone.conf"
fi

# ─── 3. tar + age ────────────────────────────────────────────────────────────
ARCHIVE="${WORK_DIR}/env-${STAMP}.tar.gz"
tar -czf "${ARCHIVE}" -C "${WORK_DIR}" "env-${STAMP}"
log "Архив: $(numfmt --to=iec "$(stat -c%s "${ARCHIVE}")")"

ENCRYPTED="${ARCHIVE}.age"
age -r "${AGE_PUBKEY}" -o "${ENCRYPTED}" "${ARCHIVE}"
log "Зашифровано: $(numfmt --to=iec "$(stat -c%s "${ENCRYPTED}")")"

# ─── 4. Заливка ──────────────────────────────────────────────────────────────
S3_PATH="${S3_REMOTE}/env/$(basename "${ENCRYPTED}")"
if command -v rclone >/dev/null 2>&1; then
    log "Заливка → ${S3_PATH}"
    rclone copyto "${ENCRYPTED}" "${S3_PATH}" --s3-no-check-bucket
    log "Готово ✓"
else
    # На dev-машине без rclone — просто сохраняем локально
    LOCAL_OUT="${REPO_DIR}/backups-local"
    mkdir -p "${LOCAL_OUT}"
    cp "${ENCRYPTED}" "${LOCAL_OUT}/"
    log "rclone не установлен — сохранил локально: ${LOCAL_OUT}/$(basename "${ENCRYPTED}")"
fi
