#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# migrate-data-apply.sh — применить мигрированный пакет на VPS
#
# Запускается НА VPS, после того как migrate-data-to-vps.sh залил архивы.
#
# Использование:
#   bash scripts/migrate-data-apply.sh /opt/crm/migrate-in/<TIMESTAMP>
#
# Алгоритм:
#   1. Останавливает прикладные сервисы (postgres оставляет работать)
#   2. Восстанавливает Postgres dump через pg_restore
#   3. Распаковывает архивы сессий в Docker volumes
#   4. Запускает прикладные сервисы
#   5. Smoke: проверяет что все healthy
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/deploy/docker-compose.production.yml"
ENV_FILE="$PROJECT_ROOT/.env.production"

PACKAGE_DIR="${1:-}"
if [ -z "$PACKAGE_DIR" ] || [ ! -d "$PACKAGE_DIR" ]; then
  echo "Usage: $0 <path-to-migrate-package>" >&2
  echo "Example: $0 /opt/crm/migrate-in/20260609_120000" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi
set -o allexport
# shellcheck disable=SC1090
source "$ENV_FILE"
set +o allexport

echo "================================================================"
echo "  CRM migration apply"
echo "================================================================"
echo "  Package: $PACKAGE_DIR"
echo "  Compose: $COMPOSE_FILE"
echo ""
cat "$PACKAGE_DIR/MANIFEST.txt" 2>/dev/null || echo "(no MANIFEST.txt)"
echo ""
read -r -p "Продолжить? Текущие данные в БД и volumes будут перезаписаны. [y/N] " confirm
if [[ ! "$confirm" =~ ^[yY]$ ]]; then
  echo "Aborted."
  exit 0
fi

# ── 1. Stop app services (postgres needed for restore) ──────────────────────
echo ""
echo "[1/5] Stopping application services..."
docker compose -f "$COMPOSE_FILE" stop \
  gravity-mvp tg-bot tg-bot-frontend \
  yandex-fleet-scraper-api yandex-fleet-scraper-worker \
  max-web-scraper nginx 2>&1 | sed 's/^/  /'

# ── 2. Ensure postgres is up ────────────────────────────────────────────────
echo ""
echo "[2/5] Ensuring postgres is up..."
docker compose -f "$COMPOSE_FILE" up -d postgres
echo "  waiting for postgres healthy..."
for i in {1..30}; do
  if docker exec crm-postgres pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; then
    echo "  ✓ postgres ready"
    break
  fi
  sleep 2
done

# ── 3. Restore Postgres ─────────────────────────────────────────────────────
DUMP_FILE="$PACKAGE_DIR/crm.dump"
if [ -f "$DUMP_FILE" ]; then
  echo ""
  echo "[3/5] Restoring Postgres dump..."
  # Drop and recreate schema to ensure clean import
  docker exec -i crm-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
    "DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public; GRANT ALL ON SCHEMA public TO $POSTGRES_USER; GRANT ALL ON SCHEMA public TO public;"

  docker exec -i crm-postgres pg_restore \
    -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
    --no-owner --no-acl --verbose \
    < "$DUMP_FILE" 2>&1 | tail -20
  echo "  ✓ restored"
else
  echo "[3/5] No crm.dump — skipping DB restore"
fi

# ── 4. Restore Docker volumes from tar.gz ───────────────────────────────────
restore_volume() {
  local archive="$1"; local volume="$2"
  local arc_path="$PACKAGE_DIR/$archive"
  if [ ! -f "$arc_path" ]; then
    echo "  [skip] $archive — not in package"
    return
  fi
  echo "  [restore] $archive → volume $volume"
  # Создаём volume если его ещё нет
  docker volume create "$volume" >/dev/null
  # Очищаем и распаковываем
  docker run --rm \
    -v "$volume:/data" \
    -v "$PACKAGE_DIR:/backup:ro" \
    alpine sh -c "cd /data && rm -rf ./* ./.[!.]* 2>/dev/null; tar -xzf /backup/$archive --strip-components=1 -C /data"
}

echo ""
echo "[4/5] Restoring Docker volumes..."
restore_volume "gravity-whatsapp.tar.gz"    "crm_gravity_whatsapp"
restore_volume "gravity-recordings.tar.gz"  "crm_gravity_recordings"
restore_volume "yfs-chrome-profile.tar.gz"  "crm_yfs_chrome_profile"
restore_volume "yfs-chrome-user-data.tar.gz" "crm_yfs_chrome_user_data"
restore_volume "max-user-data.tar.gz"        "crm_max_user_data"

# ── 5. Start everything + smoke ─────────────────────────────────────────────
echo ""
echo "[5/5] Starting full stack..."
docker compose -f "$COMPOSE_FILE" up -d

echo ""
echo "  waiting 30s for services to settle..."
sleep 30

echo ""
echo "==> Container status:"
docker compose -f "$COMPOSE_FILE" ps

echo ""
echo "==> Postgres tables count:"
docker exec crm-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT schemaname, COUNT(*) AS tables FROM pg_tables WHERE schemaname='public' GROUP BY schemaname;" || true

echo ""
echo "==> Prisma migrations check (B-9 from audit):"
echo "    Ожидается ровно 36 миграций для gravity-mvp, иначе при старте"
echo "    gravity-mvp контейнера 'prisma migrate deploy' попытается применить"
echo "    недостающие и упадёт."
docker exec crm-postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
  "SELECT COUNT(*) AS applied_migrations FROM _prisma_migrations WHERE finished_at IS NOT NULL;" || \
  echo "    [warn] _prisma_migrations table нет — это OK для свежей БД, миграции применятся через CMD контейнера"

echo ""
echo "✓ Migration complete."
echo ""
echo "Next steps:"
echo "  - Проверить вход в CRM:        curl -k https://\$CRM_DOMAIN/"
echo "  - Проверить tg-bot logs:       docker logs --tail 30 crm-tg-bot"
echo "  - Проверить yfs-worker logs:   docker logs --tail 30 crm-yfs-worker"
echo "  - Удалить пакет миграции:      rm -rf $PACKAGE_DIR"
