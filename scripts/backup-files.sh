#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# backup-files.sh — ежедневный бэкап Docker volumes (сессии + recordings)
#
# Запускается по cron:
#   30 3 * * * cd /opt/crm && bash scripts/backup-files.sh >> /var/log/crm-backup-files.log 2>&1
#
# Что бэкапит (из Docker volumes):
#   - crm_gravity_whatsapp        (WhatsApp session)
#   - crm_max_user_data           (MAX Web Playwright profile)
#   - crm_yfs_chrome_profile      (Yandex Fleet Chrome)
#   - crm_yfs_chrome_user_data    (Yandex Fleet user data)
#   - crm_minio_data              (recordings — большой объём, отдельный архив)
#   - crm_freeswitch_recordings   (raw recordings на FS — короткий retention)
#
# Архив: tar+gzip, зашифрован через age, залит в S3.
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

log() { printf "\033[1;34m[backup-files]\033[0m %s %s\n" "$(date -Iseconds)" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

# Volumes для бэкапа — pairs "volume_name:archive_short_name"
# Recordings (minio + freeswitch) бэкапим в отдельные архивы — они большие,
# восстановление обычно нужно частичное.
SESSION_VOLUMES=(
    "crm_gravity_whatsapp:gravity-whatsapp"
    "crm_max_user_data:max-userdata"
    "crm_yfs_chrome_profile:yfs-chrome-profile"
    "crm_yfs_chrome_user_data:yfs-chrome-userdata"
)

RECORDING_VOLUMES=(
    "crm_minio_data:minio"
    "crm_freeswitch_recordings:freeswitch-recordings"
)

backup_volume() {
    local vol="$1"
    local short="$2"
    local prefix="$3"   # files | calls

    if ! docker volume inspect "${vol}" >/dev/null 2>&1; then
        log "  - ${vol} (volume не существует — пропуск)"
        return
    fi

    local archive="${WORK_DIR}/${short}-${STAMP}.tar.gz"
    log "Архивирую ${vol}..."
    docker run --rm \
        -v "${vol}:/src:ro" \
        -v "${WORK_DIR}:/out" \
        alpine sh -c "tar -czf /out/$(basename ${archive}) -C /src . 2>/dev/null || [ \$? -eq 1 ]"

    local size; size=$(stat -c%s "${archive}" 2>/dev/null || echo 0)
    log "  → $(numfmt --to=iec "${size}")"

    [ "${size}" -lt 100 ] && { log "  [skip] архив подозрительно мал"; return; }

    # age encryption (если есть public key)
    local upload="${archive}"
    local AGE_PUBKEY_FILE="${REPO_DIR}/deploy/secrets/age-public.key"
    if [ -f "${AGE_PUBKEY_FILE}" ]; then
        local AGE_PUBKEY; AGE_PUBKEY=$(grep -E '^age1' "${AGE_PUBKEY_FILE}" | head -1)
        if [ -n "${AGE_PUBKEY}" ]; then
            age -r "${AGE_PUBKEY}" -o "${archive}.age" "${archive}"
            rm -f "${archive}"
            upload="${archive}.age"
        fi
    fi

    local s3_path="${S3_REMOTE}/${prefix}/$(basename "${upload}")"
    log "  ↑ ${s3_path}"
    rclone copyto "${upload}" "${s3_path}" --s3-no-check-bucket

    rm -f "${upload}"
}

log "Старт: stamp=${STAMP}"

# Проверка зависимостей
command -v docker >/dev/null || fail "docker не установлен"
command -v rclone >/dev/null || fail "rclone не установлен"

# === Session volumes (мелкие, в files/) ===
for pair in "${SESSION_VOLUMES[@]}"; do
    backup_volume "${pair%:*}" "${pair#*:}" "files"
done

# === Recording volumes (большие, в calls/) ===
for pair in "${RECORDING_VOLUMES[@]}"; do
    backup_volume "${pair%:*}" "${pair#*:}" "calls"
done

log "Готово ✓"
