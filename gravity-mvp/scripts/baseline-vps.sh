#!/bin/sh
# Одноразовый baseline БД, созданной через `prisma db push`:
# помечает ВСЕ существующие миграции применёнными, не выполняя их.
# После этого Dockerfile CMD `prisma migrate deploy` применяет только новые.
#
# Запуск на VPS (изнутри контейнера gravity-mvp):
#   docker exec crm-gravity-mvp sh /app/scripts/baseline-vps.sh
#
# Идемпотентен: уже записанные миграции пропускаются (resolve вернёт
# ошибку P3008 "already recorded as applied" — игнорируем).
set -u
cd "$(dirname "$0")/.."

for dir in prisma/migrations/*/; do
    name=$(basename "$dir")
    [ "$name" = "migration_lock.toml" ] && continue
    echo "resolve --applied $name"
    npx prisma migrate resolve --applied "$name" 2>&1 | grep -E 'marked as applied|P3008|already recorded' || true
done

echo "Baseline complete. Checking status:"
npx prisma migrate status
