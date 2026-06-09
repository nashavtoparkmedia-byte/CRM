#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-files.sh — ежедневный бэкап профилей браузера и сессионных данных
#
# Запускается по cron:
#   30 3 * * * cd /opt/crm && bash scripts/backup-files.sh >> /var/log/crm-backup-files.log 2>&1
#
# Что бэкапит:
#   - max-web-scraper/userData/         (сессия MAX Web)
#   - yandex-fleet-scraper/chrome_profile/  (сессия fleet.yandex.ru)
#   - gravity-mvp/.wwebjs_auth/         (сессия WhatsApp Web)
#
# Архив: tar+gzip, зашифрован через age (если public key есть), залит в S3.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

[ -f .env.production ] && { set -a; . .env.production; set +a; }
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR=$(mktemp -d)
trap "rm -rf '${WORK_DIR}'" EXIT
ARCHIVE="${WORK_DIR}/files-${STAMP}.tar.gz"

log() { printf "\033[1;34m[backup-files]\033[0m %s %s\n" "$(date -Iseconds)" "$*"; }

log "Старт: stamp=${STAMP}"

# Список путей для бэкапа — те, которые реально существуют
PATHS=()
for P in \
    "max-web-scraper/userData" \
    "yandex-fleet-scraper/chrome_profile" \
    "gravity-mvp/.wwebjs_auth" \
    "gravity-mvp/whatsapp_auth"
do
    if [ -d "${P}" ]; then
        PATHS+=("${P}")
        log "  + ${P} ($(du -sh "${P}" | cut -f1))"
    else
        log "  - ${P} (нет — пропуск)"
    fi
done

[ "${#PATHS[@]}" -gt 0 ] || { log "Нечего бэкапить — выход"; exit 0; }

# ─── 1. tar + gzip ───────────────────────────────────────────────────────────
log "Создаю архив..."
# --warning=no-file-changed: пока браузер активен, файлы могут меняться — не падаем
tar --warning=no-file-changed --warning=no-file-removed \
    -czf "${ARCHIVE}" "${PATHS[@]}" || \
    { TAR_RC=$?; [ "${TAR_RC}" -eq 1 ] || { log "[fail] tar вернул ${TAR_RC}"; exit "${TAR_RC}"; }; }

ARCHIVE_SIZE=$(stat -c%s "${ARCHIVE}")
log "Архив: $(numfmt --to=iec "${ARCHIVE_SIZE}")"

# ─── 2. Шифрование через age ─────────────────────────────────────────────────
UPLOAD_FILE="${ARCHIVE}"
AGE_PUBKEY_FILE="${REPO_DIR}/deploy/secrets/age-public.key"
if [ -f "${AGE_PUBKEY_FILE}" ]; then
    AGE_PUBKEY=$(grep -E '^age1' "${AGE_PUBKEY_FILE}" | head -1)
    if [ -n "${AGE_PUBKEY}" ]; then
        log "Шифрую через age..."
        age -r "${AGE_PUBKEY}" -o "${ARCHIVE}.age" "${ARCHIVE}"
        rm -f "${ARCHIVE}"
        UPLOAD_FILE="${ARCHIVE}.age"
    fi
fi

# ─── 3. Заливка ──────────────────────────────────────────────────────────────
S3_PATH="${S3_REMOTE}/files/$(basename "${UPLOAD_FILE}")"
log "Заливка → ${S3_PATH}"
rclone copyto "${UPLOAD_FILE}" "${S3_PATH}" --s3-no-check-bucket

log "Готово ✓"
