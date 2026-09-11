#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy.sh — выкатить новую версию на VPS
#
# Запускать на VPS из /opt/crm:
#   bash scripts/deploy.sh                # все сервисы
#   bash scripts/deploy.sh gravity-mvp    # только один сервис
#
# Что делает:
#   1. git pull
#   2. docker compose build (с --pull для обновления базовых образов)
#   3. docker compose up -d (rolling update — старый умирает после healthy)
#   4. Удаляет старые dangling images
#   5. Шлёт уведомление в @yoko_park_bot
#
# Безопасные приёмы:
#   - Перед pull делает git fetch и показывает diff — если изменения слишком
#     большие, переспрашивает.
#   - Билдит ПЕРЕД up — если билд упал, прод продолжает работать на старой версии.
#   - Проверяет healthcheck нового контейнера ДО признания деплоя успешным.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

[ -f .env.production ] && { set -a; . .env.production; set +a; }

COMPOSE_FILE="deploy/docker-compose.production.yml"

# Some hosts run additional project services from overlay compose files that
# live outside this repository (a staged release directory, for example). They
# still belong to the same compose project, so every compose invocation — and
# especially `up --remove-orphans` below — must see them, otherwise compose
# considers them orphans and deletes running services.
#
# The repository owns the contract; the host owns the paths. Declare them in
# .env.production, space-separated and absolute:
#   COMPOSE_OVERLAY_FILES="/srv/releases/foo/deploy/foo.yml /srv/releases/bar.yml"
#
# Only additive overlays belong here. An overlay that also re-pins the image of a
# canonical service (`image: ...` + `pull_policy: never`) would freeze that
# service and silently defeat this deploy; such a release freeze must be applied
# deliberately, not on every deploy. The orphan guard below is what keeps an
# undeclared service from being destroyed in the meantime.

log() { printf "\033[1;34m[deploy]\033[0m %s %s\n" "$(date -Iseconds)" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; alert "❌ deploy упал: $*"; exit 1; }

alert() {
    [ -n "${ALERT_BOT_TOKEN:-}" ] || return 0
    [ -n "${ALERT_CHAT_ID:-}" ] || return 0
    curl -sS -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
        -d "chat_id=${ALERT_CHAT_ID}" \
        -d "text=$1" >/dev/null 2>&1 || true
}

COMPOSE_OVERLAY_ARGS=""
for overlay in ${COMPOSE_OVERLAY_FILES:-}; do
    [ -f "${overlay}" ] || fail "COMPOSE_OVERLAY_FILES ссылается на отсутствующий файл: ${overlay}"
    COMPOSE_OVERLAY_ARGS="${COMPOSE_OVERLAY_ARGS} -f ${overlay}"
done

# shellcheck disable=SC2086
COMPOSE="docker compose --env-file .env.production -f ${COMPOSE_FILE}${COMPOSE_OVERLAY_ARGS}"

TARGET_SERVICES="${*:-}"

# ─── 1. Git pull ─────────────────────────────────────────────────────────────
log "Шаг 1/5: git fetch & show changes"
git fetch origin
LOCAL=$(git rev-parse HEAD)
REMOTE=$(git rev-parse "@{u}")

if [ "${LOCAL}" = "${REMOTE}" ]; then
    log "Локально и remote совпадают (${LOCAL:0:7}) — ничего обновлять не нужно"
    log "Если хочешь форсировать rebuild — добавь флаг --force-rebuild (TODO)"
    exit 0
fi

log "Изменения с ${LOCAL:0:7} до ${REMOTE:0:7}:"
git log --oneline "${LOCAL}..${REMOTE}" | head -20

# Sanity check — если diff > 100 файлов, переспрашиваем
DIFF_FILES=$(git diff --name-only "${LOCAL}" "${REMOTE}" | wc -l)
if [ "${DIFF_FILES}" -gt 100 ]; then
    log "[warn] меняется ${DIFF_FILES} файлов — это много"
    if [ -t 0 ]; then
        read -r -p "Продолжить? (yes/NO): " CONFIRM
        [ "${CONFIRM}" = "yes" ] || fail "Отменено пользователем"
    else
        log "[skip] неинтерактивный режим — продолжаем"
    fi
fi

git pull --ff-only origin "$(git rev-parse --abbrev-ref HEAD)" || fail "git pull не удался"
log "git pull → $(git rev-parse HEAD)"

# ─── 2. Build ────────────────────────────────────────────────────────────────
log "Шаг 2/5: docker compose build"
BUILD_START=$(date +%s)
if [ -n "${TARGET_SERVICES}" ]; then
    # shellcheck disable=SC2086
    ${COMPOSE} build --pull ${TARGET_SERVICES} || fail "build упал"
else
    ${COMPOSE} build --pull || fail "build упал"
fi
BUILD_TIME=$(($(date +%s) - BUILD_START))
log "build OK (${BUILD_TIME}s)"

# ─── 3. Применить миграции (для gravity-mvp) ────────────────────────────────
if [ -z "${TARGET_SERVICES}" ] || echo "${TARGET_SERVICES}" | grep -q "gravity-mvp"; then
    log "Шаг 3/5: prisma migrate deploy (через временный контейнер)"
    ${COMPOSE} run --rm gravity-mvp npx prisma migrate deploy || \
        fail "миграции не применились"
fi

# ─── 4. Up ───────────────────────────────────────────────────────────────────
# `--remove-orphans` deletes containers whose service is absent from the compose
# files being applied. It cannot distinguish "service was deleted from the file"
# from "service this invocation simply cannot see", so it is destructive by
# default on any project that carries a service declared elsewhere. Deploying
# does not require it, so it is opt-in: set DEPLOY_REMOVE_ORPHANS=true only when
# you actually intend to prune deleted services.
if [ "${DEPLOY_REMOVE_ORPHANS:-false}" = "true" ]; then
    # Requested — now prove it is safe. Every running container in the project
    # must be defined by the compose files we are about to apply; if one is not,
    # stop instead of destroying a live service.
    log "Шаг 4/5: проверка orphan-безопасности (DEPLOY_REMOVE_ORPHANS=true)"
    # Compose derives the project name from COMPOSE_PROJECT_NAME, else the base
    # directory name — mirror that here rather than shelling out to a JSON parser.
    PROJECT_NAME="${COMPOSE_PROJECT_NAME:-$(basename "${REPO_DIR}")}"

    DEFINED_SERVICES="$(${COMPOSE} config --services 2>/dev/null | sort -u)"
    RUNNING_SERVICES="$(docker ps --filter "label=com.docker.compose.project=${PROJECT_NAME}" -q \
        | xargs -r docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' 2>/dev/null \
        | sort -u)"
    UNDECLARED="$(comm -13 <(printf '%s\n' "${DEFINED_SERVICES}") <(printf '%s\n' "${RUNNING_SERVICES}") | grep -v '^$' || true)"

    if [ -n "${UNDECLARED}" ]; then
        log "[fail] в проекте ${PROJECT_NAME} работают сервисы, которых нет в применяемых compose-файлах:"
        printf '  - %s\n' ${UNDECLARED} >&2
        fail "добавьте их compose-файлы в COMPOSE_OVERLAY_FILES (.env.production) или снимите DEPLOY_REMOVE_ORPHANS, иначе --remove-orphans их уничтожит"
    fi

    log "Шаг 4/5: docker compose up -d --remove-orphans"
    # Both branches are spelled out rather than assembling the flag into a
    # variable, so the deployment form stays literally greppable: the accepted
    # migration authority control locates this exact step to prove migrations are
    # applied, and verified, before application code is replaced.
    # shellcheck disable=SC2086
    ${COMPOSE} up -d --remove-orphans ${TARGET_SERVICES} || fail "up упал"
else
    log "Шаг 4/5: docker compose up -d (--remove-orphans отключён)"
    # shellcheck disable=SC2086
    ${COMPOSE} up -d ${TARGET_SERVICES} || fail "up упал"
fi

# ─── 5. Ждём healthy ─────────────────────────────────────────────────────────
log "Шаг 5/5: проверка healthcheck'ов (до 120 сек)"
TIMEOUT=120
ELAPSED=0
while [ "${ELAPSED}" -lt "${TIMEOUT}" ]; do
    UNHEALTHY=$(${COMPOSE} ps --format json 2>/dev/null | \
        jq -r 'select(.Health == "unhealthy" or .Health == "starting") | .Name' | wc -l)
    if [ "${UNHEALTHY}" -eq 0 ]; then
        log "Все сервисы healthy ✓"
        break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
done

if [ "${ELAPSED}" -ge "${TIMEOUT}" ]; then
    UNHEALTHY_NAMES=$(${COMPOSE} ps --format json | \
        jq -r 'select(.Health == "unhealthy") | .Name' | paste -sd, -)
    fail "сервисы не стали healthy за ${TIMEOUT}s: ${UNHEALTHY_NAMES}"
fi

# ─── Cleanup ─────────────────────────────────────────────────────────────────
log "Cleanup: удаляю dangling images"
docker image prune -f >/dev/null || true

NEW_REV=$(git rev-parse --short HEAD)
SUMMARY="✅ deploy OK → ${NEW_REV}"
[ -n "${TARGET_SERVICES}" ] && SUMMARY="${SUMMARY} (${TARGET_SERVICES})"
log "${SUMMARY}"
alert "${SUMMARY}"
