#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-pg.sh — восстановление PostgreSQL из бэкапа
#
# Использование:
#   bash scripts/restore-pg.sh                         # последний бэкап из S3
#   bash scripts/restore-pg.sh pg-20260609T030000Z.dump.age   # конкретный
#   bash scripts/restore-pg.sh /path/to/local.dump     # локальный файл
#
# Требует:
#   - .env.production с POSTGRES_USER / POSTGRES_DB
#   - Запущенный контейнер crm-postgres
#   - Если файл .age — приватный age-ключ (попросит ввести путь)
#
# ВНИМАНИЕ: целевая база ДРОПАЕТСЯ перед restore. Спросит подтверждение.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

[ -f .env.production ] || { echo "[fail] .env.production не найден"; exit 1; }
set -a; . .env.production; set +a

: "${POSTGRES_USER:?POSTGRES_USER required}"
: "${POSTGRES_DB:?POSTGRES_DB required}"
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"
PG_CONTAINER="${PG_CONTAINER:-crm-postgres}"

log() { printf "\033[1;34m[restore-pg]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

ARG="${1:-LATEST}"
WORK_DIR=$(mktemp -d)
trap "rm -rf '${WORK_DIR}'" EXIT

# ─── 1. Получить файл бэкапа ─────────────────────────────────────────────────
if [ "${ARG}" = "LATEST" ]; then
    log "Ищу последний бэкап в ${S3_REMOTE}/pg/..."
    LATEST=$(rclone lsf "${S3_REMOTE}/pg/" --files-only | sort | tail -1)
    [ -n "${LATEST}" ] || fail "В S3 нет бэкапов"
    log "Последний: ${LATEST}"
    rclone copyto "${S3_REMOTE}/pg/${LATEST}" "${WORK_DIR}/${LATEST}"
    SRC="${WORK_DIR}/${LATEST}"
elif [ -f "${ARG}" ]; then
    SRC="${ARG}"
    log "Локальный файл: ${SRC}"
else
    log "Качаю ${ARG} из S3..."
    rclone copyto "${S3_REMOTE}/pg/${ARG}" "${WORK_DIR}/${ARG}"
    SRC="${WORK_DIR}/${ARG}"
fi

# ─── 2. Расшифровать если .age ───────────────────────────────────────────────
if [[ "${SRC}" == *.age ]]; then
    log "Файл зашифрован — нужен приватный age-ключ"
    read -r -p "Путь к age private key (~/age-key.txt): " AGE_KEY_PATH
    AGE_KEY_PATH="${AGE_KEY_PATH/#\~/$HOME}"
    [ -f "${AGE_KEY_PATH}" ] || fail "Ключ не найден: ${AGE_KEY_PATH}"
    DECRYPTED="${SRC%.age}"
    age -d -i "${AGE_KEY_PATH}" -o "${DECRYPTED}" "${SRC}"
    SRC="${DECRYPTED}"
    log "Расшифровано: ${SRC}"
fi

# ─── 3. Подтверждение ────────────────────────────────────────────────────────
log "ВНИМАНИЕ: база '${POSTGRES_DB}' в контейнере ${PG_CONTAINER} будет ДРОПНУТА"
log "Размер дампа: $(numfmt --to=iec "$(stat -c%s "${SRC}")")"
read -r -p "Продолжить? (yes/NO): " CONFIRM
[ "${CONFIRM}" = "yes" ] || fail "Отменено пользователем"

# ─── 4. Восстановление ───────────────────────────────────────────────────────
log "Создаю backup текущей базы перед restore (на всякий случай)..."
SAFETY_DUMP="${WORK_DIR}/safety-before-restore.dump"
docker exec -i "${PG_CONTAINER}" pg_dump -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" --format=custom > "${SAFETY_DUMP}" 2>/dev/null || true
log "Safety dump: $(numfmt --to=iec "$(stat -c%s "${SAFETY_DUMP}")")"

log "Дроп и пересоздание базы ${POSTGRES_DB}..."
docker exec -i "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d postgres <<SQL
SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='${POSTGRES_DB}' AND pid <> pg_backend_pid();
DROP DATABASE IF EXISTS ${POSTGRES_DB};
CREATE DATABASE ${POSTGRES_DB};
SQL

log "pg_restore..."
docker exec -i "${PG_CONTAINER}" pg_restore \
    -U "${POSTGRES_USER}" \
    -d "${POSTGRES_DB}" \
    --no-owner --no-privileges \
    --verbose < "${SRC}" 2> >(grep -v '^pg_restore:' >&2) || \
    log "[warn] pg_restore вернул ненулевой код — посмотри предупреждения"

# ─── 5. Проверка ─────────────────────────────────────────────────────────────
TABLE_COUNT=$(docker exec -i "${PG_CONTAINER}" psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d ' ')
log "Таблиц в восстановленной базе: ${TABLE_COUNT}"
[ "${TABLE_COUNT}" -gt 0 ] || fail "В базе 0 таблиц после restore — что-то пошло не так"

log "Готово ✓ Safety dump сохранён в ${SAFETY_DUMP} (будет удалён при выходе)"
log "Если что-то не так — НЕ выходи, скопируй ${SAFETY_DUMP} в безопасное место"
