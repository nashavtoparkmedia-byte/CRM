#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# setup-server.sh — первичная установка CRM на чистый Beget VPS (Ubuntu 22.04)
#
# ЗАПУСКАТЬ ОТ root ОДИН РАЗ при покупке VPS:
#   ssh root@<IP>
#   bash setup-server.sh
#
# Скрипт ИДЕМПОТЕНТНЫЙ — можно запустить повторно, не сломается.
# Каждый шаг проверяет, не сделан ли он уже.
#
# Что делает:
#   1. Системные апдейты + базовые утилиты
#   2. Пользователь crm (не работаем из-под root)
#   3. Swap 6 GB
#   4. Docker + docker compose plugin
#   5. FreeSWITCH (на хост, не в Docker — для UDP/RTP голоса)
#   6. coturn   (на хост, не в Docker — TURN relay)
#   7. xray     (на хост, не в Docker — SOCKS5 для Claude API)
#   8. age      (шифрование .env)
#   9. rclone   (отправка бэкапов в Selectel S3)
#  10. UFW firewall (открыты только SSH/HTTP/HTTPS/SIP/RTP)
#
# После завершения — следовать docs/DEPLOY.md, раздел 3, шаг 3.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# Цветной лог
log()  { printf "\033[1;34m[setup]\033[0m %s\n" "$*"; }
ok()   { printf "\033[1;32m[ ok ]\033[0m %s\n" "$*"; }
skip() { printf "\033[1;33m[skip]\033[0m %s\n" "$*"; }
fail() { printf "\033[1;31m[fail]\033[0m %s\n" "$*" >&2; exit 1; }

# Проверка что мы root
[ "$(id -u)" -eq 0 ] || fail "Запускать от root: sudo bash setup-server.sh"

# Проверка ОС
. /etc/os-release
[ "${ID:-}" = "ubuntu" ] || fail "Только Ubuntu (нашёл: ${ID:-неизвестно})"
log "Ubuntu $VERSION_ID обнаружена"

CRM_USER="crm"
CRM_HOME="/home/${CRM_USER}"
CRM_APP_DIR="/opt/crm"

# ─── 1. Системные апдейты + утилиты ──────────────────────────────────────────
log "Шаг 1/10: apt update + базовые утилиты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
    curl wget gnupg ca-certificates lsb-release \
    htop iotop net-tools dnsutils jq unzip \
    ufw fail2ban \
    git make build-essential
ok "Утилиты установлены"

# ─── 2. Пользователь crm ─────────────────────────────────────────────────────
log "Шаг 2/10: пользователь ${CRM_USER}"
if id "${CRM_USER}" >/dev/null 2>&1; then
    skip "Пользователь ${CRM_USER} уже существует"
else
    adduser --disabled-password --gecos "" "${CRM_USER}"
    usermod -aG sudo "${CRM_USER}"
    # SSH-ключ root → crm (чтобы можно было сразу логиниться)
    mkdir -p "${CRM_HOME}/.ssh"
    if [ -f /root/.ssh/authorized_keys ]; then
        cp /root/.ssh/authorized_keys "${CRM_HOME}/.ssh/authorized_keys"
        chown -R "${CRM_USER}:${CRM_USER}" "${CRM_HOME}/.ssh"
        chmod 700 "${CRM_HOME}/.ssh"
        chmod 600 "${CRM_HOME}/.ssh/authorized_keys"
    fi
    ok "Пользователь ${CRM_USER} создан (в группе sudo)"
fi

# Каталог приложения
mkdir -p "${CRM_APP_DIR}"
chown "${CRM_USER}:${CRM_USER}" "${CRM_APP_DIR}"

# ─── 3. Swap 6 GB ────────────────────────────────────────────────────────────
log "Шаг 3/10: swap 6 GB"
SWAP_FILE="/swapfile"
if swapon --show | grep -q "${SWAP_FILE}"; then
    skip "Swap уже включён: $(swapon --show | grep "${SWAP_FILE}")"
else
    fallocate -l 6G "${SWAP_FILE}"
    chmod 600 "${SWAP_FILE}"
    mkswap "${SWAP_FILE}" >/dev/null
    swapon "${SWAP_FILE}"
    # На постоянку
    if ! grep -q "${SWAP_FILE}" /etc/fstab; then
        echo "${SWAP_FILE} none swap sw 0 0" >> /etc/fstab
    fi
    # Тюн под наш профиль (низкий swappiness — swap как страховка от OOM, не для постоянной работы)
    sysctl -w vm.swappiness=10 >/dev/null
    sysctl -w vm.vfs_cache_pressure=50 >/dev/null
    cat > /etc/sysctl.d/99-crm-memory.conf <<EOF
vm.swappiness=10
vm.vfs_cache_pressure=50
EOF
    ok "Swap 6 GB включён и прописан в fstab"
fi

# ─── 4. Docker + compose plugin ──────────────────────────────────────────────
log "Шаг 4/10: Docker"
if command -v docker >/dev/null 2>&1; then
    skip "Docker уже установлен: $(docker --version)"
else
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
        | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
        > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq \
        docker-ce docker-ce-cli containerd.io \
        docker-buildx-plugin docker-compose-plugin
    systemctl enable --now docker
    usermod -aG docker "${CRM_USER}"
    ok "Docker установлен: $(docker --version)"
fi

# ─── 5. FreeSWITCH (на хост) ─────────────────────────────────────────────────
log "Шаг 5/10: FreeSWITCH (на хост, не в Docker)"
if command -v freeswitch >/dev/null 2>&1; then
    skip "FreeSWITCH уже установлен"
else
    # SignalWire репозиторий (нужен TOKEN от signalwire.com — пока ставим из universe как заглушку)
    # Полная установка делается отдельным скриптом scripts/setup-freeswitch.sh после получения токена.
    log "FreeSWITCH требует SignalWire token — пропускаем автоустановку"
    log "См. docs/operations/freeswitch-install.md для ручной установки"
fi

# ─── 6. coturn (TURN-relay) ──────────────────────────────────────────────────
log "Шаг 6/10: coturn"
if command -v turnserver >/dev/null 2>&1; then
    skip "coturn уже установлен"
else
    apt-get install -y -qq coturn
    # Включить демон
    sed -i 's/^#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn || true
    # Базовый конфиг — конкретные параметры (realm, shared-secret) добавим вручную позже
    ok "coturn установлен (конфиг — отдельно)"
fi

# ─── 7. xray (SOCKS5 для Claude API) ─────────────────────────────────────────
log "Шаг 7/10: xray"
if command -v xray >/dev/null 2>&1; then
    skip "xray уже установлен: $(xray version 2>&1 | head -1)"
else
    # Официальный installer
    bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
    # Конфиг (/usr/local/etc/xray/config.json) — заполняется вручную после получения VLESS-ссылки
    systemctl enable xray
    ok "xray установлен (конфиг — отдельно, /usr/local/etc/xray/config.json)"
fi

# ─── 8. age (шифрование .env) ────────────────────────────────────────────────
log "Шаг 8/10: age"
if command -v age >/dev/null 2>&1; then
    skip "age уже установлен: $(age --version 2>&1)"
else
    apt-get install -y -qq age
    ok "age установлен"
fi

# ─── 9. rclone (отправка бэкапов в S3) ───────────────────────────────────────
log "Шаг 9/10: rclone"
if command -v rclone >/dev/null 2>&1; then
    skip "rclone уже установлен: $(rclone version | head -1)"
else
    curl -fsSL https://rclone.org/install.sh | bash
    ok "rclone установлен"
    log "ВАЖНО: после установки запустить от пользователя crm:"
    log "  sudo -u ${CRM_USER} rclone config"
    log "  и завести remote с именем 'selectel' (S3-compatible)"
fi

# ─── 10. UFW firewall ────────────────────────────────────────────────────────
log "Шаг 10/10: UFW firewall"
if ufw status | grep -q "Status: active"; then
    skip "UFW уже активен"
else
    ufw --force reset >/dev/null
    ufw default deny incoming
    ufw default allow outgoing
    ufw allow 22/tcp        comment 'SSH'
    ufw allow 80/tcp        comment 'HTTP (Let'\''s Encrypt + redirect)'
    ufw allow 443/tcp       comment 'HTTPS'
    ufw allow 5060/udp      comment 'SIP signaling'
    ufw allow 5060/tcp      comment 'SIP signaling TCP'
    ufw allow 16384:32768/udp comment 'RTP media'
    ufw allow 3478/udp      comment 'TURN/STUN'
    ufw allow 3478/tcp      comment 'TURN/STUN'
    ufw allow 49152:65535/udp comment 'TURN relay range'
    ufw --force enable
    ok "UFW активен"
fi

# fail2ban — базовая защита SSH от перебора
systemctl enable --now fail2ban >/dev/null 2>&1 || true

# ─── Финал ───────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════════════════════════════════════"
ok "Базовая установка сервера завершена"
echo "════════════════════════════════════════════════════════════════════════"
cat <<EOF

ЧТО ДАЛЬШЕ — следовать docs/DEPLOY.md:

  1. Залогиниться от пользователя crm:
       ssh ${CRM_USER}@$(hostname -I | awk '{print $1}')

  2. Склонировать репозиторий в ${CRM_APP_DIR}:
       cd ${CRM_APP_DIR}
       git clone <repo-url> .

  3. Подготовить .env.production (см. docs/SECRETS.md):
       cp .env.production.example .env.production
       nano .env.production    # заполнить значения
       chmod 600 .env.production

  4. Настроить rclone (Selectel S3):
       rclone config           # name: selectel, type: s3, provider: Other

  5. Положить age PUBLIC ключ:
       echo "age1..." > deploy/secrets/age-public.key

  6. Поднять базовый стек:
       cd ${CRM_APP_DIR}
       docker compose -f deploy/docker-compose.production.yml up -d postgres redis nginx

  7. Настроить cron бэкапы и health-monitor — см. docs/DEPLOY.md разделы 5-6.

EOF
