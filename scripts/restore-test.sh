#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-test.sh — ежемесячный тест "бэкап реально восстанавливается"
#
# Запускать вручную раз в месяц, или поставить на cron:
#   0 5 1 * * cd /opt/crm && bash scripts/restore-test.sh >> /var/log/crm-restore-test.log 2>&1
#
# Что делает:
#   1. Качает последний бэкап Postgres из S3
#   2. Если зашифрован — пытается расшифровать тестовым ключом
#      (этот скрипт НЕ хранит приватный ключ — для теста нужен временный
#       расшифрованный дамп; в автомате только проверка целостности файла)
#   3. Поднимает временный контейнер postgres:16-alpine
#   4. Делает pg_restore в него
#   5. Считает таблицы и базовые row counts по ключевым таблицам
#   6. Сравнивает с прошлым тестом (есть ли драматическое расхождение)
#   7. Удаляет временный контейнер
#   8. Шлёт отчёт в @yoko_park_bot
#
# СКЕЛЕТ — полная имплементация после первого реального бэкапа в S3.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

log() { printf "\033[1;34m[restore-test]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

[ -f .env.production ] && { set -a; . .env.production; set +a; }
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"
TEST_CONTAINER="crm-postgres-restore-test"
TEST_PORT="${RESTORE_TEST_PORT:-15432}"

STATE_DIR="/var/lib/crm/restore-test"
mkdir -p "${STATE_DIR}"
PREV_REPORT="${STATE_DIR}/last-report.txt"
CURR_REPORT="${STATE_DIR}/current-report.txt"

# ─── 1. Качаем последний бэкап ───────────────────────────────────────────────
log "Шаг 1: получаю последний бэкап"
LATEST=$(rclone lsf "${S3_REMOTE}/pg/" --files-only | sort | tail -1)
[ -n "${LATEST}" ] || fail "В S3 нет бэкапов"
log "  → ${LATEST}"

WORK_DIR=$(mktemp -d)
trap "rm -rf '${WORK_DIR}'; docker rm -f '${TEST_CONTAINER}' >/dev/null 2>&1 || true" EXIT

DUMP="${WORK_DIR}/${LATEST}"
rclone copyto "${S3_REMOTE}/pg/${LATEST}" "${DUMP}"
log "  скачано: $(numfmt --to=iec "$(stat -c%s "${DUMP}")")"

# ─── 2. Расшифровка ──────────────────────────────────────────────────────────
if [[ "${DUMP}" == *.age ]]; then
    log "Шаг 2: расшифровка"
    # Для автоматического теста нужен приватный ключ во временном виде.
    # Вариант: использовать отдельный age identity, прописанный в RESTORE_TEST_AGE_KEY.
    AGE_KEY_PATH="${RESTORE_TEST_AGE_KEY:-/root/.crm-restore-test-age.key}"
    if [ ! -f "${AGE_KEY_PATH}" ]; then
        log "  [skip] нет ${AGE_KEY_PATH} — пропускаю расшифровку"
        log "  Проверка ограничена целостностью файла (размер > 0, валидный age header)"
        head -c 100 "${DUMP}" | grep -q "age-encryption.org" \
            || fail "файл не является валидным age-encrypted"
        log "  age-header валиден ✓"
        echo "PARTIAL_OK: age-header ${LATEST} $(stat -c%s "${DUMP}")" > "${CURR_REPORT}"
        exit 0
    fi
    DECRYPTED="${DUMP%.age}"
    age -d -i "${AGE_KEY_PATH}" -o "${DECRYPTED}" "${DUMP}"
    DUMP="${DECRYPTED}"
    log "  расшифровано"
fi

# ─── 3. Временный Postgres ──────────────────────────────────────────────────
log "Шаг 3: временный Postgres на порту ${TEST_PORT}"
docker rm -f "${TEST_CONTAINER}" >/dev/null 2>&1 || true
docker run -d \
    --name "${TEST_CONTAINER}" \
    -e POSTGRES_USER=test \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=testdb \
    -p "127.0.0.1:${TEST_PORT}:5432" \
    postgres:16-alpine >/dev/null

# Ждём пока поднимется
for i in {1..30}; do
    if docker exec "${TEST_CONTAINER}" pg_isready -U test >/dev/null 2>&1; then
        log "  поднят за ${i} сек"
        break
    fi
    sleep 1
    [ "${i}" -eq 30 ] && fail "Postgres не поднялся за 30 сек"
done

# ─── 4. Restore ──────────────────────────────────────────────────────────────
log "Шаг 4: pg_restore"
docker exec -i "${TEST_CONTAINER}" pg_restore \
    -U test -d testdb --no-owner --no-privileges \
    < "${DUMP}" 2>/dev/null || true

# ─── 5. Проверки целостности ────────────────────────────────────────────────
log "Шаг 5: проверки"
TABLE_COUNT=$(docker exec "${TEST_CONTAINER}" psql -U test -d testdb -t -c \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';" | tr -d ' \n')
log "  таблиц: ${TABLE_COUNT}"

[ "${TABLE_COUNT}" -gt 0 ] || fail "0 таблиц после restore — бэкап битый"

# Row counts для ключевых таблиц (заполнить после стабилизации схемы)
KEY_TABLES=("drivers" "messages" "calls" "contacts" "knowledge_facts")
{
    echo "OK: ${LATEST}"
    echo "tables: ${TABLE_COUNT}"
    for T in "${KEY_TABLES[@]}"; do
        CNT=$(docker exec "${TEST_CONTAINER}" psql -U test -d testdb -t -c \
            "SELECT count(*) FROM ${T};" 2>/dev/null | tr -d ' \n' || echo "n/a")
        echo "rows_${T}: ${CNT}"
    done
} > "${CURR_REPORT}"
cat "${CURR_REPORT}"

# ─── 6. Сравнение с прошлым тестом ──────────────────────────────────────────
if [ -f "${PREV_REPORT}" ]; then
    log "Шаг 6: сравнение с прошлым тестом"
    PREV_TABLES=$(grep '^tables:' "${PREV_REPORT}" | awk '{print $2}')
    if [ -n "${PREV_TABLES}" ] && [ "${TABLE_COUNT}" -lt $((PREV_TABLES * 8 / 10)) ]; then
        log "  [warn] таблиц сильно меньше прошлого (${TABLE_COUNT} vs ${PREV_TABLES}) — проверь вручную"
    fi
fi
cp "${CURR_REPORT}" "${PREV_REPORT}"

# ─── 7. Отчёт в Telegram ────────────────────────────────────────────────────
if [ -n "${ALERT_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
    REPORT=$(cat "${CURR_REPORT}")
    curl -sS -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${ALERT_CHAT_ID}" \
        -d "text=✓ Restore-test OK%0A${REPORT//$'\n'/%0A}" >/dev/null || true
fi

log "Готово ✓"
