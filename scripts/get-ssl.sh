#!/bin/bash
# ──────────────────────────────────────────────────────────────────────────────
# get-ssl.sh — получение / продление SSL-сертификатов Let's Encrypt
#
# Использует certbot в Docker через webroot challenge:
#   - nginx уже запущен и слушает :80
#   - challenge-файлы кладутся в volume crm_nginx_www
#   - сертификаты в volume crm_nginx_certs (примонтирован в nginx как /etc/letsencrypt)
#
# Использование:
#   bash scripts/get-ssl.sh           # первичный выпуск (issue)
#   bash scripts/get-ssl.sh --renew   # продление существующих
#   bash scripts/get-ssl.sh --staging # тест на Let's Encrypt staging (без rate-limit)
#
# В крон на VPS:
#   0 3 * * * cd /opt/crm && bash scripts/get-ssl.sh --renew >> /var/log/crm/ssl-renew.log 2>&1
# ──────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$PROJECT_ROOT/deploy/docker-compose.production.yml"
ENV_FILE="$PROJECT_ROOT/.env.production"

MODE="issue"
STAGING_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --renew)   MODE="renew" ;;
    --staging) STAGING_FLAG="--staging" ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ── Load .env.production ─────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found. Copy .env.production.example and fill it." >&2
  exit 1
fi
set -o allexport
# shellcheck disable=SC1090
source "$ENV_FILE"
set +o allexport

# ── Verify required vars ─────────────────────────────────────────────────────
for var in CRM_DOMAIN BOT_ADMIN_DOMAIN LETSENCRYPT_EMAIL; do
  val="${!var:-}"
  if [ -z "$val" ] || [[ "$val" == _disabled_* ]]; then
    echo "ERROR: $var not set or disabled in .env.production" >&2
    exit 1
  fi
done

echo "==> SSL $MODE for: $CRM_DOMAIN, $BOT_ADMIN_DOMAIN"
echo "    email: $LETSENCRYPT_EMAIL"
[ -n "$STAGING_FLAG" ] && echo "    STAGING mode (test certificates)"

# ── Ensure nginx is running (needed for webroot challenge) ───────────────────
if ! docker compose -f "$COMPOSE_FILE" ps nginx | grep -q "Up\|running"; then
  echo "==> Starting nginx (required for webroot challenge)..."
  docker compose -f "$COMPOSE_FILE" up -d nginx
  sleep 5
fi

# ── Run certbot ──────────────────────────────────────────────────────────────
if [ "$MODE" = "issue" ]; then
  echo "==> Issuing new certificates..."
  docker run --rm \
    -v crm_nginx_certs:/etc/letsencrypt \
    -v crm_nginx_www:/var/www/letsencrypt \
    certbot/certbot:latest certonly \
    --webroot -w /var/www/letsencrypt \
    --non-interactive --agree-tos \
    $STAGING_FLAG \
    --email "$LETSENCRYPT_EMAIL" \
    -d "$CRM_DOMAIN" \
    -d "$BOT_ADMIN_DOMAIN"
else
  echo "==> Renewing existing certificates..."
  docker run --rm \
    -v crm_nginx_certs:/etc/letsencrypt \
    -v crm_nginx_www:/var/www/letsencrypt \
    certbot/certbot:latest renew \
    --webroot -w /var/www/letsencrypt \
    --non-interactive
fi

# ── Reload nginx to pick up new certs ────────────────────────────────────────
echo "==> Reloading nginx..."
docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload

echo ""
echo "✓ Done. Certificates in volume crm_nginx_certs."
echo "  Inspect: docker run --rm -v crm_nginx_certs:/data alpine ls /data/live/"
