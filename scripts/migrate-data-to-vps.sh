#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# migrate-data-to-vps.sh — единоразовая миграция данных с локалки на VPS
#
# Что переносит:
#   1. PostgreSQL — pg_dump локальной БД (через docker postgres:16-alpine)
#   2. gravity-mvp/whatsapp_auth/  → volume crm_gravity_whatsapp
#   3. gravity-mvp/recordings/     → volume crm_gravity_recordings (если есть)
#   4. yandex-fleet-scraper/chrome_user_data/, chrome_profile/  → crm_yfs_*
#   5. max-web-scraper/userData/   → volume crm_max_user_data
#
# Алгоритм:
#   локально → создаём tar.gz архивы → scp на VPS → запускаем migrate-data-apply.sh
#
# Использование:
#   export VPS_HOST=1.2.3.4
#   export VPS_USER=crm
#   export DB_USER=...     # локальная БД
#   export DB_PASSWORD=...
#   export DB_NAME=crm
#   export DB_HOST=localhost  # default; на Windows из Docker — host.docker.internal
#   export DB_PORT=5432
#   bash scripts/migrate-data-to-vps.sh
#
# На VPS должен быть установлен setup-server.sh, /opt/crm с git checkout
# и .env.production. Контейнеры можно не запускать — скрипт сам остановит.
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
STAGING_DIR="/tmp/crm-migrate-$TIMESTAMP"

# ── Required env vars ───────────────────────────────────────────────────────
for var in VPS_HOST VPS_USER DB_USER DB_PASSWORD DB_NAME; do
  if [ -z "${!var:-}" ]; then
    echo "ERROR: env var $var is required" >&2
    echo "See header comment for usage." >&2
    exit 1
  fi
done
DB_HOST="${DB_HOST:-host.docker.internal}"
DB_PORT="${DB_PORT:-5432}"

echo "================================================================"
echo "  CRM data migration to VPS"
echo "================================================================"
echo "  Source: local (DB ${DB_HOST}:${DB_PORT}/${DB_NAME})"
echo "  Target: ${VPS_USER}@${VPS_HOST}"
echo "  Staging: $STAGING_DIR"
echo ""

mkdir -p "$STAGING_DIR"

# ── 1. pg_dump ──────────────────────────────────────────────────────────────
echo "[1/5] PostgreSQL dump..."
docker run --rm \
  -e PGPASSWORD="$DB_PASSWORD" \
  -v "$STAGING_DIR:/dump" \
  postgres:16-alpine \
  pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" -d "$DB_NAME" \
    -Fc --no-owner --no-acl \
    -f "/dump/crm.dump"
PG_SIZE_MB=$(du -m "$STAGING_DIR/crm.dump" | cut -f1)
echo "  → crm.dump (${PG_SIZE_MB} MB)"

# ── 2-5. Tar профили / сессии ───────────────────────────────────────────────
archive() {
  local name="$1"; local src="$2"
  if [ -d "$src" ] && [ -n "$(ls -A "$src" 2>/dev/null)" ]; then
    echo "[$name] archiving $src..."
    tar -czf "$STAGING_DIR/${name}.tar.gz" -C "$(dirname "$src")" "$(basename "$src")"
    local sz; sz=$(du -m "$STAGING_DIR/${name}.tar.gz" | cut -f1)
    echo "  → ${name}.tar.gz (${sz} MB)"
  else
    echo "[$name] $src empty or missing — skipping"
  fi
}

echo ""
echo "[2/5] gravity-mvp WhatsApp session..."
archive "gravity-whatsapp"  "$PROJECT_ROOT/gravity-mvp/whatsapp_auth"

echo ""
echo "[3/5] gravity-mvp recordings (если есть)..."
archive "gravity-recordings" "$PROJECT_ROOT/gravity-mvp/recordings"

echo ""
echo "[4/5] yandex-fleet-scraper Chrome profile..."
archive "yfs-chrome-profile"   "$PROJECT_ROOT/yandex-fleet-scraper/chrome_profile"
archive "yfs-chrome-user-data" "$PROJECT_ROOT/yandex-fleet-scraper/chrome_user_data"

echo ""
echo "[5/5] max-web-scraper userData..."
archive "max-user-data" "$PROJECT_ROOT/max-web-scraper/userData"

# ── 6. Manifest ─────────────────────────────────────────────────────────────
cat > "$STAGING_DIR/MANIFEST.txt" <<EOF
CRM migration package
Timestamp: $TIMESTAMP
Source DB: $DB_HOST:$DB_PORT/$DB_NAME

Files:
$(ls -lh "$STAGING_DIR" | grep -v MANIFEST)

Apply on VPS:
  cd /opt/crm
  sudo bash scripts/migrate-data-apply.sh /opt/crm/migrate-in/$TIMESTAMP
EOF

echo ""
echo "[*] Manifest:"
cat "$STAGING_DIR/MANIFEST.txt"

# ── 7. Upload ───────────────────────────────────────────────────────────────
REMOTE_DIR="/opt/crm/migrate-in/$TIMESTAMP"
echo ""
echo "[upload] rsync → $VPS_USER@$VPS_HOST:$REMOTE_DIR"
ssh "$VPS_USER@$VPS_HOST" "mkdir -p $REMOTE_DIR"
rsync -avz --progress "$STAGING_DIR/" "$VPS_USER@$VPS_HOST:$REMOTE_DIR/"

echo ""
echo "✓ Upload complete."
echo ""
echo "Next step — apply on VPS:"
echo "  ssh $VPS_USER@$VPS_HOST"
echo "  cd /opt/crm"
echo "  bash scripts/migrate-data-apply.sh $REMOTE_DIR"
echo ""
echo "Staging on local: $STAGING_DIR (можно удалить после успешного apply)"
