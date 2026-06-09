#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# health-monitor.sh — мониторинг сервисов с алертами в Telegram
#
# Запускается по cron раз в минуту:
#   * * * * * cd /opt/crm && bash scripts/health-monitor.sh >> /var/log/crm-health.log 2>&1
#
# Что проверяет:
#   - Все Docker-контейнеры в статусе healthy / running
#   - Свободное место на диске > 10 GB
#   - Postgres отвечает на pg_isready
#   - Redis отвечает на PING
#   - FreeSWITCH (на хосте) — systemctl is-active
#   - coturn (на хосте) — systemctl is-active
#   - Последний бэкап в S3 — не старше 26 часов
#   - Загрузка CPU и память (предупреждение если > 90%)
#
# Логика алертов:
#   - Шлёт алерт когда статус меняется (OK → FAIL или FAIL → OK)
#   - Не спамит каждую минуту, пока проблема не исчезнет
#   - Состояние хранится в /var/lib/crm/health-state/
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail   # без -e: мы сами обрабатываем неуспех каждой проверки

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

[ -f .env.production ] && { set -a; . .env.production; set +a; }
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"
STATE_DIR="${HEALTH_STATE_DIR:-/var/lib/crm/health-state}"
mkdir -p "${STATE_DIR}"

# ─── Helpers ─────────────────────────────────────────────────────────────────
ALERTS=()
record() {
    # record <check-name> <ok|fail> <message>
    local NAME="$1" STATUS="$2" MSG="$3"
    local STATE_FILE="${STATE_DIR}/${NAME}.state"
    local PREV="unknown"
    [ -f "${STATE_FILE}" ] && PREV=$(cat "${STATE_FILE}")
    echo "${STATUS}" > "${STATE_FILE}"
    # Алерт только при изменении статуса
    if [ "${PREV}" != "${STATUS}" ]; then
        local ICON="🚨"
        [ "${STATUS}" = "ok" ] && ICON="✅"
        ALERTS+=("${ICON} ${NAME}: ${MSG}")
    fi
}

# ─── 1. Docker-контейнеры ────────────────────────────────────────────────────
EXPECTED_CONTAINERS="${EXPECTED_CONTAINERS:-crm-postgres crm-redis crm-nginx}"
for C in ${EXPECTED_CONTAINERS}; do
    STATUS=$(docker inspect --format='{{.State.Status}}' "${C}" 2>/dev/null || echo "missing")
    HEALTH=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "${C}" 2>/dev/null || echo "missing")
    if [ "${STATUS}" = "running" ] && { [ "${HEALTH}" = "healthy" ] || [ "${HEALTH}" = "none" ]; }; then
        record "container_${C}" "ok" "running"
    else
        record "container_${C}" "fail" "status=${STATUS} health=${HEALTH}"
    fi
done

# ─── 2. Свободное место ──────────────────────────────────────────────────────
DISK_FREE_GB=$(df -BG / | awk 'NR==2 {gsub("G","",$4); print $4}')
if [ "${DISK_FREE_GB:-0}" -lt 10 ]; then
    record "disk_free" "fail" "${DISK_FREE_GB}GB свободно (< 10GB)"
else
    record "disk_free" "ok" "${DISK_FREE_GB}GB"
fi

# ─── 3. Postgres ─────────────────────────────────────────────────────────────
if docker exec crm-postgres pg_isready -U "${POSTGRES_USER:-postgres}" >/dev/null 2>&1; then
    record "postgres_ready" "ok" "pg_isready"
else
    record "postgres_ready" "fail" "не отвечает"
fi

# ─── 4. Redis ────────────────────────────────────────────────────────────────
if docker exec crm-redis redis-cli ping 2>/dev/null | grep -q PONG; then
    record "redis_ping" "ok" "PONG"
else
    record "redis_ping" "fail" "не отвечает"
fi

# ─── 5. FreeSWITCH (на хосте) ────────────────────────────────────────────────
if systemctl is-active --quiet freeswitch 2>/dev/null; then
    record "freeswitch" "ok" "active"
elif systemctl list-unit-files freeswitch.service >/dev/null 2>&1; then
    record "freeswitch" "fail" "inactive"
# Если FreeSWITCH ещё не установлен — не алертим (на этапе деплоя его нет)
fi

# ─── 6. coturn (на хосте) ────────────────────────────────────────────────────
if systemctl is-active --quiet coturn 2>/dev/null; then
    record "coturn" "ok" "active"
elif systemctl list-unit-files coturn.service >/dev/null 2>&1; then
    record "coturn" "fail" "inactive"
fi

# ─── 7. Свежесть последнего бэкапа ───────────────────────────────────────────
if command -v rclone >/dev/null 2>&1; then
    LATEST_BACKUP_UNIX=$(rclone lsl "${S3_REMOTE}/pg/" 2>/dev/null | \
        awk '{print $2" "$3}' | sort | tail -1 | xargs -I{} date -d "{}" +%s 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE_HOURS=$(( (NOW - LATEST_BACKUP_UNIX) / 3600 ))
    if [ "${LATEST_BACKUP_UNIX}" -eq 0 ]; then
        record "backup_age" "fail" "бэкапов нет"
    elif [ "${AGE_HOURS}" -gt 26 ]; then
        record "backup_age" "fail" "последний ${AGE_HOURS}ч назад"
    else
        record "backup_age" "ok" "${AGE_HOURS}ч"
    fi
fi

# ─── 8. CPU и память ─────────────────────────────────────────────────────────
MEM_USED_PCT=$(free | awk '/Mem:/ {printf "%.0f", $3/$2 * 100}')
if [ "${MEM_USED_PCT:-0}" -gt 90 ]; then
    record "memory" "fail" "RAM ${MEM_USED_PCT}%"
else
    record "memory" "ok" "RAM ${MEM_USED_PCT}%"
fi

LOAD_1MIN=$(awk '{print $1}' /proc/loadavg)
CORES=$(nproc)
LOAD_RATIO=$(awk -v l="${LOAD_1MIN}" -v c="${CORES}" 'BEGIN { printf "%.0f", l/c * 100 }')
if [ "${LOAD_RATIO}" -gt 200 ]; then
    record "load" "fail" "load=${LOAD_1MIN} (${LOAD_RATIO}% от ${CORES} ядер)"
else
    record "load" "ok" "load=${LOAD_1MIN}"
fi

# ─── Отправка алертов ────────────────────────────────────────────────────────
if [ "${#ALERTS[@]}" -gt 0 ]; then
    MSG="CRM health update ($(hostname)):%0A"
    for A in "${ALERTS[@]}"; do
        MSG="${MSG}${A}%0A"
    done

    if [ -n "${ALERT_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
        curl -sS -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
            -d "chat_id=${ALERT_CHAT_ID}" \
            -d "text=${MSG}" \
            -d "parse_mode=HTML" >/dev/null || \
            echo "[warn] не удалось отправить алерт в Telegram"
    fi

    # Лог для grep'а
    echo "$(date -Iseconds) ALERTS: ${ALERTS[*]}"
fi
