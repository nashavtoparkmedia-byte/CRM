#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-files.sh — восстановление Docker volumes из S3-бэкапов
#
# Пара к backup-files.sh. Используется при:
#   - переезде на новый VPS (full disaster recovery)
#   - восстановлении конкретной сессии (например, WhatsApp слетел)
#
# Использование:
#   bash scripts/restore-files.sh                 # все volumes из LATEST бэкапа
#   bash scripts/restore-files.sh gravity-whatsapp # только конкретный
#   bash scripts/restore-files.sh --calls          # включая recordings
#
# ВНИМАНИЕ: целевой volume ОЧИЩАЕТСЯ перед восстановлением.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
REPO_DIR="$( cd "${SCRIPT_DIR}/.." && pwd )"
cd "${REPO_DIR}"

[ -f .env.production ] && { set -a; . .env.production; set +a; }
S3_REMOTE="${BACKUP_S3_REMOTE:-selectel:crm-backups}"

log() { printf "\033[1;34m[restore-files]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

# Map: archive-short-name → volume name
declare -A SHORT_TO_VOLUME=(
    [gravity-whatsapp]=crm_gravity_whatsapp
    [max-userdata]=crm_max_user_data
    [yfs-chrome-profile]=crm_yfs_chrome_profile
    [yfs-chrome-userdata]=crm_yfs_chrome_user_data
    [minio]=crm_minio_data
    [freeswitch-recordings]=crm_freeswitch_recordings
)

INCLUDE_CALLS=false
SHORT_FILTER=""
for arg in "$@"; do
    case "$arg" in
        --calls) INCLUDE_CALLS=true ;;
        --help|-h)
            echo "Usage: $0 [--calls] [SHORT_NAME]"
            echo "Available shorts: ${!SHORT_TO_VOLUME[@]}"
            exit 0
            ;;
        *) SHORT_FILTER="$arg" ;;
    esac
done

command -v rclone >/dev/null || fail "rclone не установлен"
command -v docker >/dev/null || fail "docker не установлен"

WORK_DIR=$(mktemp -d)
trap "rm -rf '${WORK_DIR}'" EXIT

restore_one() {
    local short="$1"
    local volume="${SHORT_TO_VOLUME[$short]:-}"
    [ -n "$volume" ] || fail "Неизвестный архив: $short"

    # Определяем папку S3: files/ для сессий, calls/ для recordings
    local s3_dir="files"
    case "$short" in
        minio|freeswitch-recordings) s3_dir="calls" ;;
    esac

    log "=== ${short} → volume ${volume} ==="

    # Найти последний архив этого типа
    local latest; latest=$(rclone lsf "${S3_REMOTE}/${s3_dir}/" --files-only 2>/dev/null \
        | grep "^${short}-" | sort | tail -1)
    [ -n "$latest" ] || { log "  [skip] нет архивов ${short}-* в ${S3_REMOTE}/${s3_dir}/"; return; }
    log "  Latest: ${latest}"

    # Скачать
    rclone copyto "${S3_REMOTE}/${s3_dir}/${latest}" "${WORK_DIR}/${latest}"
    local src="${WORK_DIR}/${latest}"

    # Расшифровать если .age
    if [[ "$src" == *.age ]]; then
        local key="${RESTORE_AGE_KEY:-$HOME/age-key.txt}"
        [ -f "$key" ] || fail "Нет age private key (RESTORE_AGE_KEY или $HOME/age-key.txt)"
        local decrypted="${src%.age}"
        age -d -i "$key" -o "$decrypted" "$src"
        src="$decrypted"
        log "  расшифровано"
    fi

    # Подтверждение
    log "  ВНИМАНИЕ: volume ${volume} будет ОЧИЩЕН и перезаписан"
    read -r -p "  Продолжить? (yes/NO): " confirm
    [ "$confirm" = "yes" ] || { log "  пропущено"; return; }

    # Создать volume если нет, очистить, развернуть
    docker volume create "$volume" >/dev/null
    docker run --rm \
        -v "${volume}:/dst" \
        -v "${WORK_DIR}:/in:ro" \
        alpine sh -c "cd /dst && rm -rf ./* ./.[!.]* 2>/dev/null; tar -xzf /in/$(basename $src) -C /dst"
    log "  ✓ восстановлено"
}

log "Старт. Source: ${S3_REMOTE}"

if [ -n "$SHORT_FILTER" ]; then
    restore_one "$SHORT_FILTER"
else
    for short in "${!SHORT_TO_VOLUME[@]}"; do
        # Сессии всегда; recordings (calls) только с флагом --calls
        case "$short" in
            minio|freeswitch-recordings)
                $INCLUDE_CALLS || { log "[skip] $short (use --calls)"; continue; }
                ;;
        esac
        restore_one "$short"
    done
fi

log "Готово ✓"
