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

TEST_ALERT_ONLY=0
TEST_ALERT=0
DRY_RUN=0
for ARG in "$@"; do
    case "${ARG}" in
        --test-alert) TEST_ALERT=1 ;;
        --test-only) TEST_ALERT=1; TEST_ALERT_ONLY=1 ;;
        --dry-run) DRY_RUN=1 ;;
    esac
done

PRODUCTION_ENV_FILE="${CRM_PRODUCTION_ENV_FILE:-${REPO_DIR}/.env.production}"
OPERATIONAL_ENV_FILE="${CRM_OPERATIONAL_ENV_FILE:-/var/lib/crm/max-personal-text-operational.env}"
[ -f "${PRODUCTION_ENV_FILE}" ] && { set -a; . "${PRODUCTION_ENV_FILE}"; set +a; }
[ -f "${OPERATIONAL_ENV_FILE}" ] && { set -a; . "${OPERATIONAL_ENV_FILE}"; set +a; }
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

safe_alert_message() {
    # safe_alert_message <service> <safe-code> <first-action> <detail>
    local SERVICE="$1" CODE="$2" FIRST_ACTION="$3" DETAIL="$4"
    printf 'service=%s code=%s time=%s first_action=%s detail=%s' \
        "${SERVICE}" "${CODE}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${FIRST_ACTION}" "${DETAIL}"
}

record_safe() {
    # record_safe <check-name> <ok|fail> <service> <safe-code> <first-action> <detail>
    local NAME="$1" STATUS="$2" SERVICE="$3" CODE="$4" FIRST_ACTION="$5" DETAIL="$6"
    record "${NAME}" "${STATUS}" "$(safe_alert_message "${SERVICE}" "${CODE}" "${FIRST_ACTION}" "${DETAIL}")"
}

record_delayed_safe() {
    # record_delayed_safe <check-name> <bad:0|1> <threshold-sec> <service> <safe-code> <first-action> <detail> <ok-detail>
    local NAME="$1" BAD="$2" THRESHOLD="$3" SERVICE="$4" CODE="$5" FIRST_ACTION="$6" DETAIL="$7" OK_DETAIL="$8"
    local SINCE_FILE="${STATE_DIR}/${NAME}.since"
    local NOW ELAPSED SINCE
    NOW=$(date +%s)
    if [ "${BAD}" = "1" ]; then
        if [ ! -f "${SINCE_FILE}" ]; then
            echo "${NOW}" > "${SINCE_FILE}"
        fi
        SINCE=$(cat "${SINCE_FILE}" 2>/dev/null || echo "${NOW}")
        ELAPSED=$(( NOW - SINCE ))
        if [ "${ELAPSED}" -ge "${THRESHOLD}" ]; then
            record_safe "${NAME}" "fail" "${SERVICE}" "${CODE}" "${FIRST_ACTION}" "${DETAIL}; duration=${ELAPSED}s"
        else
            record_safe "${NAME}" "ok" "${SERVICE}" "${CODE}" "${FIRST_ACTION}" "${OK_DETAIL}; grace_elapsed=${ELAPSED}s"
        fi
    else
        rm -f "${SINCE_FILE}"
        record_safe "${NAME}" "ok" "${SERVICE}" "${CODE}" "${FIRST_ACTION}" "${OK_DETAIL}"
    fi
}

http_json_from_container() {
    # http_json_from_container <container> <url>
    local CONTAINER="$1" URL="$2"
    docker exec "${CONTAINER}" node -e '
const http = require("http");
const url = process.argv[1];
const req = http.get(url, (res) => {
  let body = "";
  res.on("data", (chunk) => { body += chunk; });
  res.on("end", () => {
    let parsed = body;
    try { parsed = JSON.parse(body); } catch (_) {}
    process.stdout.write(JSON.stringify({ status: res.statusCode, body: parsed }));
  });
});
req.setTimeout(5000, () => req.destroy(new Error("timeout")));
req.on("error", (error) => {
  process.stdout.write(JSON.stringify({ status: 0, error: String(error && error.message || error) }));
  process.exitCode = 2;
});
' "${URL}" 2>/dev/null
}

if [ "${TEST_ALERT}" -eq 1 ]; then
    ALERTS+=("🧪 personal_max_text_v1_monitor_test: $(safe_alert_message "personal-max-text-v1" "TEST_MODE" "no_action_required" "test notification without artificial production failure")")
fi

if [ "${TEST_ALERT_ONLY}" -eq 0 ]; then

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
if [ -n "${REDIS_PASSWORD:-}" ]; then
    REDIS_PING=$(docker exec -e REDISCLI_AUTH="${REDIS_PASSWORD}" crm-redis redis-cli ping 2>/dev/null || true)
else
    REDIS_PING=$(docker exec crm-redis redis-cli ping 2>/dev/null || true)
fi
if printf '%s' "${REDIS_PING}" | grep -q PONG; then
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
if [ "${HEALTH_MONITOR_ENABLE_S3_BACKUP_CHECK:-true}" = "true" ] && command -v rclone >/dev/null 2>&1; then
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

# ─── 9. Personal MAX Text v1 ─────────────────────────────────────────────────
if [ "${PERSONAL_MAX_TEXT_V1_MONITOR_ENABLED:-true}" = "true" ]; then
    PMAX_QUEUE_GRACE="${PERSONAL_MAX_TEXT_V1_QUEUE_GRACE_SECONDS:-300}"
    PMAX_WS_GRACE="${PERSONAL_MAX_TEXT_V1_WS_GRACE_SECONDS:-120}"
    PMAX_BACKUP_MAX_AGE_SECONDS="${PERSONAL_MAX_TEXT_V1_BACKUP_MAX_AGE_SECONDS:-93600}"
    PMAX_DISK_MIN_FREE_BYTES="${PERSONAL_MAX_TEXT_V1_DISK_MIN_FREE_BYTES:-10737418240}"

    GW_READY_JSON=$(http_json_from_container crm-max-personal-gateway http://127.0.0.1:8080/ready || true)
    GW_STATUS=$(printf '%s' "${GW_READY_JSON}" | jq -r '.status // 0' 2>/dev/null || echo 0)
    GW_READY=$(printf '%s' "${GW_READY_JSON}" | jq -r '.body.ready // false' 2>/dev/null || echo false)
    GW_SENDER_INACTIVE=$(printf '%s' "${GW_READY_JSON}" | jq -r 'if .body.senderModulesInactive == false then "false" elif .body.senderModulesInactive == true then "true" else "missing" end' 2>/dev/null || echo missing)
    GW_PROVIDER_INACTIVE=$(printf '%s' "${GW_READY_JSON}" | jq -r 'if .body.providerActionsInactive == false then "false" elif .body.providerActionsInactive == true then "true" else "missing" end' 2>/dev/null || echo missing)
    GW_BROWSER_OWNER=$(printf '%s' "${GW_READY_JSON}" | jq -r '.body.gates.browserOwnerInvariant // false' 2>/dev/null || echo false)
    if [ "${GW_STATUS}" = "200" ] && [ "${GW_READY}" = "true" ]; then
        record_safe "personal_max_gateway_ready" "ok" "max-personal-gateway" "GATEWAY_READY" "check_gateway_ready_and_logs" "ready=200"
    else
        record_safe "personal_max_gateway_ready" "fail" "max-personal-gateway" "GATEWAY_READY_NOT_200" "enable_default_off_then_inspect_gateway" "status=${GW_STATUS} ready=${GW_READY}"
    fi
    if [ "${GW_SENDER_INACTIVE}" = "false" ] && [ "${GW_PROVIDER_INACTIVE}" = "false" ]; then
        record_safe "personal_max_sender_mode" "ok" "max-personal-gateway" "SENDER_OPERATIONAL" "no_action" "sender operational through durable fenced route"
    else
        record_safe "personal_max_sender_mode" "fail" "max-personal-gateway" "SENDER_NOT_OPERATIONAL" "check_operational_env_and_default_off_overlay" "senderModulesInactive=${GW_SENDER_INACTIVE} providerActionsInactive=${GW_PROVIDER_INACTIVE}"
    fi
    if [ "${GW_BROWSER_OWNER}" = "true" ]; then
        record_safe "personal_max_browser_owner_invariant" "ok" "max-personal-gateway" "BROWSER_OWNER_INVARIANT_OK" "no_action" "single expected owner"
    else
        record_safe "personal_max_browser_owner_invariant" "fail" "max-personal-gateway" "BROWSER_OWNER_INVARIANT_BROKEN" "enable_default_off_and_stop_parallel_browser_owners" "browserOwnerInvariant=${GW_BROWSER_OWNER}"
    fi

    GW_HEALTH_JSON=$(http_json_from_container crm-max-personal-gateway http://127.0.0.1:8080/health || true)
    GW_CAPTURE_REJECTED=$(printf '%s' "${GW_HEALTH_JSON}" | jq -r '.body.metrics.captureRejected // 0' 2>/dev/null || echo 0)
    GW_DRAIN_FAILURES=$(printf '%s' "${GW_HEALTH_JSON}" | jq -r '.body.metrics.drainFailures // 0' 2>/dev/null || echo 0)
    GW_WRONG_ACCOUNT=$(printf '%s' "${GW_HEALTH_JSON}" | jq -r '.body.metrics.wrongAccountDifferences // 0' 2>/dev/null || echo 0)
    if [ "${GW_CAPTURE_REJECTED}" = "0" ]; then
        record_safe "personal_max_capture_rejected" "ok" "max-personal-gateway" "CAPTURE_REJECTED_ZERO" "no_action" "captureRejected=0"
    else
        record_safe "personal_max_capture_rejected" "fail" "max-personal-gateway" "CAPTURE_REJECTED_GT_ZERO" "enable_default_off_and_collect_privacy_safe_evidence" "captureRejected=${GW_CAPTURE_REJECTED}"
    fi
    if [ "${GW_DRAIN_FAILURES}" = "0" ]; then
        record_safe "personal_max_drain_failures" "ok" "max-personal-gateway" "DRAIN_FAILURES_ZERO" "no_action" "drainFailures=0"
    else
        record_safe "personal_max_drain_failures" "fail" "max-personal-gateway" "DRAIN_FAILURES_GT_ZERO" "enable_default_off_and_inspect_gateway_db_connectivity" "drainFailures=${GW_DRAIN_FAILURES}"
    fi
    if [ "${GW_WRONG_ACCOUNT}" = "0" ]; then
        record_safe "personal_max_wrong_account" "ok" "max-personal-gateway" "WRONG_ACCOUNT_ZERO" "no_action" "wrongAccountDifferences=0"
    else
        record_safe "personal_max_wrong_account" "fail" "max-personal-gateway" "WRONG_ACCOUNT_GT_ZERO" "enable_default_off_and_verify_account_fencing" "wrongAccountDifferences=${GW_WRONG_ACCOUNT}"
    fi

    SCRAPER_HEALTH_JSON=$(http_json_from_container crm-max-scraper http://127.0.0.1:3005/health || true)
    SCRAPER_STATUS=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.status // 0' 2>/dev/null || echo 0)
    SCRAPER_READY=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.isReady // false' 2>/dev/null || echo false)
    SCRAPER_QUEUE=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.queueLength // 0' 2>/dev/null || echo 0)
    SCRAPER_SPOOL=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.spoolPendingCount // 0' 2>/dev/null || echo 0)
    SCRAPER_RETRY=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.retryCount // 0' 2>/dev/null || echo 0)
    SCRAPER_REJECTED=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.rejectedCount // 0' 2>/dev/null || echo 0)
    SCRAPER_QUARANTINED=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.quarantinedCount // 0' 2>/dev/null || echo 0)
    SCRAPER_LOST=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.lostBeforeSpoolCount // 0' 2>/dev/null || echo 0)
    SCRAPER_HOOK_FAILURE=$(printf '%s' "${SCRAPER_HEALTH_JSON}" | jq -r '.body.capture.hookFailureCount // 0' 2>/dev/null || echo 0)
    if [ "${SCRAPER_STATUS}" = "200" ] && [ "${SCRAPER_READY}" = "true" ]; then
        record_safe "personal_max_scraper_health" "ok" "max-web-scraper" "SCRAPER_HEALTH_OK" "no_action" "health=200"
    else
        record_safe "personal_max_scraper_health" "fail" "max-web-scraper" "SCRAPER_HEALTH_NOT_200" "enable_default_off_and_inspect_scraper_logs" "status=${SCRAPER_STATUS} ready=${SCRAPER_READY}"
    fi
    if [ "${SCRAPER_QUEUE}" -gt 0 ] 2>/dev/null; then QUEUE_BAD=1; else QUEUE_BAD=0; fi
    record_delayed_safe "personal_max_queue_nonzero" "${QUEUE_BAD}" "${PMAX_QUEUE_GRACE}" "max-web-scraper" "QUEUE_GT_ZERO" "do_not_retry_enable_default_off_if_growing" "queueLength=${SCRAPER_QUEUE}" "queueLength=${SCRAPER_QUEUE}"
    if [ "${SCRAPER_SPOOL}" -gt 0 ] 2>/dev/null; then SPOOL_BAD=1; else SPOOL_BAD=0; fi
    record_delayed_safe "personal_max_spool_pending" "${SPOOL_BAD}" "${PMAX_QUEUE_GRACE}" "max-web-scraper" "SPOOL_PENDING_GT_ZERO" "inspect_capture_drain_before_restart" "spoolPendingCount=${SCRAPER_SPOOL}" "spoolPendingCount=${SCRAPER_SPOOL}"
    if [ "${SCRAPER_RETRY}" = "0" ] && [ "${SCRAPER_REJECTED}" = "0" ] && [ "${SCRAPER_QUARANTINED}" = "0" ] && [ "${SCRAPER_LOST}" = "0" ] && [ "${SCRAPER_HOOK_FAILURE}" = "0" ]; then
        record_safe "personal_max_capture_scraper_counters" "ok" "max-web-scraper" "SCRAPER_CAPTURE_COUNTERS_ZERO" "no_action" "retry/rejected/quarantine/lost/hookFailure=0"
    else
        record_safe "personal_max_capture_scraper_counters" "fail" "max-web-scraper" "SCRAPER_CAPTURE_COUNTERS_NONZERO" "enable_default_off_and_collect_capture_evidence" "retry=${SCRAPER_RETRY} rejected=${SCRAPER_REJECTED} quarantined=${SCRAPER_QUARANTINED} lost=${SCRAPER_LOST} hookFailure=${SCRAPER_HOOK_FAILURE}"
    fi

    SCRAPER_STATUS_JSON=$(http_json_from_container crm-max-scraper http://127.0.0.1:3005/status || true)
    SCRAPER_LOGGED_IN=$(printf '%s' "${SCRAPER_STATUS_JSON}" | jq -r '.body.isLoggedIn // false' 2>/dev/null || echo false)
    SCRAPER_WS=$(printf '%s' "${SCRAPER_STATUS_JSON}" | jq -r '.body.transport.wsConnected // false' 2>/dev/null || echo false)
    SCRAPER_AUTH=$(printf '%s' "${SCRAPER_STATUS_JSON}" | jq -r '.body.transport.authenticated // false' 2>/dev/null || echo false)
    if [ "${SCRAPER_LOGGED_IN}" = "true" ] && [ "${SCRAPER_AUTH}" = "true" ]; then AUTH_BAD=0; else AUTH_BAD=1; fi
    record_delayed_safe "personal_max_authentication" "${AUTH_BAD}" "${PMAX_WS_GRACE}" "max-web-scraper" "MAX_AUTHENTICATION_LOST" "owner_reauth_may_be_required_after_default_off" "isLoggedIn=${SCRAPER_LOGGED_IN} authenticated=${SCRAPER_AUTH}" "isLoggedIn=${SCRAPER_LOGGED_IN} authenticated=${SCRAPER_AUTH}"
    if [ "${SCRAPER_WS}" = "true" ]; then WS_BAD=0; else WS_BAD=1; fi
    record_delayed_safe "personal_max_websocket" "${WS_BAD}" "${PMAX_WS_GRACE}" "max-web-scraper" "MAX_WEBSOCKET_DISCONNECTED" "inspect_scraper_network_before_restart" "wsConnected=${SCRAPER_WS}" "wsConnected=${SCRAPER_WS}"

    CRM_ROOT=$(http_json_from_container crm-gravity-mvp http://127.0.0.1:3002/messages || true)
    CRM_CONV=$(http_json_from_container crm-gravity-mvp http://127.0.0.1:3002/api/messages/conversations || true)
    CRM_ROOT_STATUS=$(printf '%s' "${CRM_ROOT}" | jq -r '.status // 0' 2>/dev/null || echo 0)
    CRM_CONV_STATUS=$(printf '%s' "${CRM_CONV}" | jq -r '.status // 0' 2>/dev/null || echo 0)
    if [ "${CRM_ROOT_STATUS}" = "200" ] && [ "${CRM_CONV_STATUS}" = "200" ]; then
        record_safe "personal_max_crm_path" "ok" "gravity-mvp" "CRM_PERSONAL_MAX_PATH_OK" "no_action" "messages=200 conversations=200"
    else
        record_safe "personal_max_crm_path" "fail" "gravity-mvp" "CRM_PERSONAL_MAX_PATH_NOT_200" "enable_default_off_if_send_path_unsafe_then_inspect_crm" "messages=${CRM_ROOT_STATUS} conversations=${CRM_CONV_STATUS}"
    fi

    PMAX_LEDGER_JSON=$(docker exec -i crm-postgres psql -U "${POSTGRES_USER:-crm}" -d "${POSTGRES_DB:-tg_bot_db}" -At 2>/dev/null <<'SQL' || true
WITH const AS (
  SELECT 'max-personal-81d98d8cc9fc95c1f1c0461f'::text AS account_id
), attempts AS (
  SELECT
    count(*) FILTER (WHERE "claimUntil" > now())::int AS active_claims,
    count(*) FILTER (WHERE "outcomeUnknownAt" IS NOT NULL AND "completedAt" IS NULL)::int AS unresolved_unknowns,
    count(*) FILTER (WHERE "safeErrorCode" ILIKE '%ACCOUNT%' AND "completedAt" IS NULL)::int AS wrong_account_errors,
    count(*) FILTER (WHERE "safeErrorCode" ILIKE '%ROUTE%' AND "completedAt" IS NULL)::int AS wrong_route_errors
  FROM "MaxOutboundDispatchAttempt", const
  WHERE "MaxOutboundDispatchAttempt"."accountId" = const.account_id
), reconciliation AS (
  SELECT count(*) FILTER (WHERE "resolvedAt" IS NULL)::int AS open_count
  FROM "MaxOutboundReconciliationTask", const
  WHERE "MaxOutboundReconciliationTask"."accountId" = const.account_id
), route_conflicts AS (
  SELECT count(*) FILTER (WHERE status IN ('open','active'))::int AS active_count
  FROM "MaxRouteConflict", const
  WHERE "MaxRouteConflict"."accountId" = const.account_id
), duplicate_provider AS (
  SELECT COALESCE(sum(extra)::int, 0) AS duplicate_count
  FROM (
    SELECT count(*) - 1 AS extra
    FROM "MaxOutboundDispatch", const
    WHERE "MaxOutboundDispatch"."accountId" = const.account_id
      AND "providerMessageId" IS NOT NULL
    GROUP BY "providerMessageId"
    HAVING count(*) > 1
  ) grouped
)
SELECT jsonb_build_object(
  'activeClaims', (SELECT active_claims FROM attempts),
  'unresolvedUnknowns', (SELECT unresolved_unknowns FROM attempts),
  'wrongAccountErrors', (SELECT wrong_account_errors FROM attempts),
  'wrongRouteErrors', (SELECT wrong_route_errors FROM attempts),
  'openReconciliation', (SELECT open_count FROM reconciliation),
  'activeRouteConflicts', (SELECT active_count FROM route_conflicts),
  'duplicateProviderActions', (SELECT duplicate_count FROM duplicate_provider)
)::text;
SQL
)
    LEDGER_ACTIVE=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.activeClaims // 999' 2>/dev/null || echo 999)
    LEDGER_UNKNOWN=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.unresolvedUnknowns // 999' 2>/dev/null || echo 999)
    LEDGER_RECON=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.openReconciliation // 999' 2>/dev/null || echo 999)
    LEDGER_ROUTE_CONFLICTS=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.activeRouteConflicts // 999' 2>/dev/null || echo 999)
    LEDGER_WRONG_ROUTE=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.wrongRouteErrors // 999' 2>/dev/null || echo 999)
    LEDGER_WRONG_ACCOUNT=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.wrongAccountErrors // 999' 2>/dev/null || echo 999)
    LEDGER_DUP_PROVIDER=$(printf '%s' "${PMAX_LEDGER_JSON}" | jq -r '.duplicateProviderActions // 999' 2>/dev/null || echo 999)
    if [ "${LEDGER_ACTIVE}" = "0" ] && [ "${LEDGER_UNKNOWN}" = "0" ]; then
        record_safe "personal_max_ledger_queue" "ok" "postgres" "LEDGER_QUEUE_ZERO" "no_action" "activeClaims=0 unresolvedUnknowns=0"
    else
        record_safe "personal_max_ledger_queue" "fail" "postgres" "LEDGER_QUEUE_NONZERO" "do_not_blind_retry_collect_ledger_evidence" "activeClaims=${LEDGER_ACTIVE} unresolvedUnknowns=${LEDGER_UNKNOWN}"
    fi
    if [ "${LEDGER_RECON}" = "0" ]; then
        record_safe "personal_max_reconciliation" "ok" "postgres" "RECONCILIATION_ZERO" "no_action" "openReconciliation=0"
    else
        record_safe "personal_max_reconciliation" "fail" "postgres" "RECONCILIATION_GT_ZERO" "do_not_retry_run_provider_store_reconciliation_read_only" "openReconciliation=${LEDGER_RECON}"
    fi
    if [ "${LEDGER_ROUTE_CONFLICTS}" = "0" ] && [ "${LEDGER_WRONG_ROUTE}" = "0" ]; then
        record_safe "personal_max_wrong_route" "ok" "postgres" "WRONG_ROUTE_ZERO" "no_action" "activeRouteConflicts=0 wrongRouteErrors=0"
    else
        record_safe "personal_max_wrong_route" "fail" "postgres" "WRONG_ROUTE_GT_ZERO" "enable_default_off_and_verify_route_registry" "activeRouteConflicts=${LEDGER_ROUTE_CONFLICTS} wrongRouteErrors=${LEDGER_WRONG_ROUTE}"
    fi
    if [ "${LEDGER_WRONG_ACCOUNT}" = "0" ]; then
        record_safe "personal_max_ledger_wrong_account" "ok" "postgres" "LEDGER_WRONG_ACCOUNT_ZERO" "no_action" "wrongAccountErrors=0"
    else
        record_safe "personal_max_ledger_wrong_account" "fail" "postgres" "LEDGER_WRONG_ACCOUNT_GT_ZERO" "enable_default_off_and_verify_account_owner" "wrongAccountErrors=${LEDGER_WRONG_ACCOUNT}"
    fi
    if [ "${LEDGER_DUP_PROVIDER}" = "0" ]; then
        record_safe "personal_max_duplicate_provider_actions" "ok" "postgres" "DUPLICATE_PROVIDER_ACTIONS_ZERO" "no_action" "duplicateProviderActions=0"
    else
        record_safe "personal_max_duplicate_provider_actions" "fail" "postgres" "DUPLICATE_PROVIDER_ACTIONS_GT_ZERO" "enable_default_off_and_do_not_retry" "duplicateProviderActions=${LEDGER_DUP_PROVIDER}"
    fi

    PMAX_RESTART_BAD=0
    PMAX_RESTART_DETAIL=""
    for C in crm-gravity-mvp crm-max-personal-gateway crm-max-scraper; do
        RC=$(docker inspect --format='{{.RestartCount}}' "${C}" 2>/dev/null || echo 999)
        PMAX_RESTART_DETAIL="${PMAX_RESTART_DETAIL}${C}=${RC} "
        if [ "${RC}" -gt 0 ] 2>/dev/null; then PMAX_RESTART_BAD=1; fi
    done
    if [ "${PMAX_RESTART_BAD}" = "0" ]; then
        record_safe "personal_max_restart_counts" "ok" "docker" "RESTART_COUNT_ZERO" "no_action" "${PMAX_RESTART_DETAIL}"
    else
        record_safe "personal_max_restart_counts" "fail" "docker" "RESTART_COUNT_GT_ZERO" "inspect_container_logs_before_restart" "${PMAX_RESTART_DETAIL}"
    fi

    PMAX_DISK_FREE=$(df -B1 / | awk 'NR==2 {print $4}')
    if [ "${PMAX_DISK_FREE:-0}" -ge "${PMAX_DISK_MIN_FREE_BYTES}" ] 2>/dev/null; then
        record_safe "personal_max_disk_free" "ok" "host" "DISK_RESERVE_OK" "no_action" "freeBytes=${PMAX_DISK_FREE}"
    else
        record_safe "personal_max_disk_free" "fail" "host" "DISK_RESERVE_LOW" "cleanup_only_allowed_temporary_cache_or_expand_disk" "freeBytes=${PMAX_DISK_FREE} threshold=${PMAX_DISK_MIN_FREE_BYTES}"
    fi

    if [ -n "${PERSONAL_MAX_TEXT_V1_BACKUP_PATH:-}" ] && [ -n "${PERSONAL_MAX_TEXT_V1_BACKUP_SHA256:-}" ]; then
        if [ -f "${PERSONAL_MAX_TEXT_V1_BACKUP_PATH}" ]; then
            BACKUP_SHA=$(sha256sum "${PERSONAL_MAX_TEXT_V1_BACKUP_PATH}" 2>/dev/null | awk '{print $1}')
            BACKUP_MTIME=$(stat -c %Y "${PERSONAL_MAX_TEXT_V1_BACKUP_PATH}" 2>/dev/null || echo 0)
            BACKUP_AGE=$(( $(date +%s) - BACKUP_MTIME ))
            if [ "${BACKUP_SHA}" = "${PERSONAL_MAX_TEXT_V1_BACKUP_SHA256}" ] && [ "${BACKUP_AGE}" -le "${PMAX_BACKUP_MAX_AGE_SECONDS}" ]; then
                record_safe "personal_max_backup" "ok" "backup" "BACKUP_VALID" "no_action" "sha=match ageSeconds=${BACKUP_AGE}"
            else
                record_safe "personal_max_backup" "fail" "backup" "BACKUP_INVALID_OR_STALE" "create_fresh_backup_before_any_release_action" "shaMatch=$([ "${BACKUP_SHA}" = "${PERSONAL_MAX_TEXT_V1_BACKUP_SHA256}" ] && echo true || echo false) ageSeconds=${BACKUP_AGE}"
            fi
        else
            record_safe "personal_max_backup" "fail" "backup" "BACKUP_MISSING" "create_fresh_backup_before_any_release_action" "path_missing"
        fi
    fi
fi

fi

# ─── Отправка алертов ────────────────────────────────────────────────────────
if [ "${#ALERTS[@]}" -gt 0 ]; then
    MSG="CRM health update ($(hostname)):%0A"
    for A in "${ALERTS[@]}"; do
        MSG="${MSG}${A}%0A"
    done

    if [ "${DRY_RUN}" -eq 1 ]; then
        echo "$(date -Iseconds) DRY_RUN_ALERTS: ${ALERTS[*]}"
    elif [ -n "${ALERT_BOT_TOKEN:-}" ] && [ -n "${ALERT_CHAT_ID:-}" ]; then
        curl -sS -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
            -d "chat_id=${ALERT_CHAT_ID}" \
            -d "text=${MSG}" \
            -d "parse_mode=HTML" >/dev/null || \
            echo "[warn] не удалось отправить алерт в Telegram"
    fi

    # Лог для grep'а
    echo "$(date -Iseconds) ALERTS: ${ALERTS[*]}"
fi
