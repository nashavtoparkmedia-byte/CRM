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
# CRM_WWW_DOMAIN и CRM_APP_DOMAIN — опциональные (для миграции на yokoone.ru).
# Если заданы — будут добавлены к выпуску cert.
CRM_WWW_DOMAIN="${CRM_WWW_DOMAIN:-}"
CRM_APP_DOMAIN="${CRM_APP_DOMAIN:-}"

echo "==> SSL $MODE for:"
echo "    CRM:       $CRM_DOMAIN${CRM_WWW_DOMAIN:+ + $CRM_WWW_DOMAIN (SAN)}"
echo "    Bot admin: $BOT_ADMIN_DOMAIN"
[ -n "$CRM_APP_DOMAIN" ] && echo "    Legacy:    $CRM_APP_DOMAIN"
echo "    email:     $LETSENCRYPT_EMAIL"
[ -n "$STAGING_FLAG" ] && echo "    STAGING mode (test certificates)"

# ── Ensure nginx is running (needed for webroot challenge) ───────────────────
if ! docker compose -f "$COMPOSE_FILE" ps nginx | grep -q "Up\|running"; then
  echo "==> Starting nginx (required for webroot challenge)..."
  docker compose -f "$COMPOSE_FILE" up -d nginx
  sleep 5
fi

# Один cert per "live path". Имя папки = первый -d (Subject CN).
# Дополнительные -d попадают в SAN.
issue_cert() {
  local primary="$1"; shift
  local sans=("$@")
  local args=(-d "$primary")
  local desc="$primary"
  for s in "${sans[@]}"; do
    args+=(-d "$s")
    desc+=" + $s"
  done
  echo "==> Issuing certificate for $desc..."
  docker run --rm \
    -v crm_nginx_certs:/etc/letsencrypt \
    -v crm_nginx_www:/var/www/letsencrypt \
    certbot/certbot:latest certonly \
    --webroot -w /var/www/letsencrypt \
    --non-interactive --agree-tos \
    --force-renewal \
    --cert-name "$primary" \
    $STAGING_FLAG \
    --email "$LETSENCRYPT_EMAIL" \
    "${args[@]}"
}

# ── Run certbot ──────────────────────────────────────────────────────────────
if [ "$MODE" = "issue" ]; then
  # 1. CRM SAN cert: apex (+ www если задан). Папка live/$CRM_DOMAIN/.
  if [ -n "$CRM_WWW_DOMAIN" ]; then
    issue_cert "$CRM_DOMAIN" "$CRM_WWW_DOMAIN"
  else
    issue_cert "$CRM_DOMAIN"
  fi

  # 2. Bot admin cert
  issue_cert "$BOT_ADMIN_DOMAIN"

  # 3. Legacy app cert (если задан и нет уже валидного)
  if [ -n "$CRM_APP_DOMAIN" ]; then
    issue_cert "$CRM_APP_DOMAIN"
  fi
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
