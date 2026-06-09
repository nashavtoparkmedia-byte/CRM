#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-pg.sh — ежедневный дамп PostgreSQL в Selectel S3
#
# Запускается по cron:
#   0 3 * * * cd /opt/crm && bash scripts/backup-pg.sh >> /var/log/crm-backup-pg.log 2>&1
#
# Что делает:
#   1. pg_dump --format=custom (компактный бинарный формат, восстанавливается pg_restore)
#   2. Сжимает уже сжатым custom-форматом, поэтому gzip снаружи не нужен
#   3. Шифрует через age (опционально, если есть deploy/secrets/age-public.key)
#   4. Заливает в S3 с датой в имени
#   5. Локальный файл удаляется после успешной заливки
#
# Retention управляется lifecycle policy bucket'а — скрипт ничего не удаляет.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Где мы
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

# Конфиг — переменные подгружаются из .env.production
[ -f .env.production ] || { echo "[fail] .env.production не найден в ${REPO_DIR}"; exit 1; }
set -a
# shellcheck source=/dev/null
. .env.production
set +a

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_DB:?POSTGRES_DB required}"
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"
PG_CONTAINER="${PG_CONTAINER:-crm-postgres}"

# Дата для имени файла — ISO без двоеточий (S3-safe)
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
DUMP_DIR="/var/backups/crm"
mkdir -p "${DUMP_DIR}"
DUMP_FILE="${DUMP_DIR}/pg-${STAMP}.dump"

log() { printf "\033[1;34m[backup-pg]\033[0m %s %s\n" "$(date -Iseconds)" "$*"; }

log "Старт: stamp=${STAMP}, container=${PG_CONTAINER}, db=${POSTGRES_DB}"

# Проверки
docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$" \
    || { log "[fail] Контейнер ${PG_CONTAINER} не запущен"; exit 1; }
command -v rclone >/dev/null || { log "[fail] rclone не установлен"; exit 1; }

# ─── 1. pg_dump ──────────────────────────────────────────────────────────────
log "pg_dump → ${DUMP_FILE}"
docker exec -i "${PG_CONTAINER}" pg_dump \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --format=custom \
    --no-owner \
    --no-privileges \
    --verbose 2> >(grep -v '^pg_dump:' >&2) \
    > "${DUMP_FILE}"

DUMP_SIZE=$(stat -c%s "${DUMP_FILE}")
log "Дамп готов: $(numfmt --to=iec "${DUMP_SIZE}")"

# Sanity check — дамп слишком мал = вероятно пустая база или ошибка
if [ "${DUMP_SIZE}" -lt 1024 ]; then
    log "[fail] Дамп подозрительно мал (${DUMP_SIZE} байт) — что-то не так"
    rm -f "${DUMP_FILE}"
    exit 1
fi

# ─── 2. Шифрование через age (если есть public key) ──────────────────────────
AGE_PUBKEY_FILE="deploy/secrets/age-public.key"
UPLOAD_FILE="${DUMP_FILE}"
if [ -f "${AGE_PUBKEY_FILE}" ]; then
    AGE_PUBKEY=$(grep -E '^age1' "${AGE_PUBKEY_FILE}" | head -1)
    if [ -n "${AGE_PUBKEY}" ]; then
        log "Шифрую через age (recipient: ${AGE_PUBKEY:0:20}...)"
        age -r "${AGE_PUBKEY}" -o "${DUMP_FILE}.age" "${DUMP_FILE}"
        rm -f "${DUMP_FILE}"
        UPLOAD_FILE="${DUMP_FILE}.age"
        log "Зашифровано: $(numfmt --to=iec "$(stat -c%s "${UPLOAD_FILE}")")"
    else
        log "[warn] ${AGE_PUBKEY_FILE} существует, но age1... ключа не нашёл — пропускаю шифрование"
    fi
else
    log "[warn] ${AGE_PUBKEY_FILE} отсутствует — заливаю БЕЗ шифрования"
fi

# ─── 3. Заливка в S3 ─────────────────────────────────────────────────────────
S3_PATH="${S3_REMOTE}/pg/$(basename "${UPLOAD_FILE}")"
log "Заливка → ${S3_PATH}"
rclone copyto "${UPLOAD_FILE}" "${S3_PATH}" --s3-no-check-bucket

# Проверка что файл реально появился в S3
RCLONE_CHECK=$(rclone size "${S3_PATH}" --json 2>/dev/null || echo '{}')
S3_SIZE=$(echo "${RCLONE_CHECK}" | jq -r '.bytes // 0')
LOCAL_SIZE=$(stat -c%s "${UPLOAD_FILE}")
if [ "${S3_SIZE}" != "${LOCAL_SIZE}" ]; then
    log "[fail] Размер в S3 (${S3_SIZE}) ≠ локальный (${LOCAL_SIZE}) — заливка повреждена"
    exit 1
fi
log "Заливка ОК: ${S3_SIZE} байт совпадают"

# ─── 4. Удаляем локальный файл ───────────────────────────────────────────────
rm -f "${UPLOAD_FILE}"
log "Локальный файл удалён"

log "Готово ✓"
