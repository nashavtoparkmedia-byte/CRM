#!/usr/bin/env bash
# Installs and starts coturn in WSL2 Ubuntu as a TURN relay for the browser
# softphone. Required because WSL2 mirrored networking blocks direct UDP
# between Chrome on Windows and FreeSWITCH on WSL2 — TURN over TCP (browser
# leg) tunnels media to coturn, which then relays to FS on the WSL2 loopback.
#
# Run inside WSL2 Ubuntu as root: sudo bash /mnt/d/Github/CRM-telephony-test/telephony/wsl-setup-coturn.sh

set -euo pipefail

CONF_SRC="$(dirname "$0")/turnserver.conf"
CONF_DST="/etc/turnserver.conf"

if ! command -v turnserver >/dev/null; then
    echo "[coturn] installing package..."
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y coturn
fi

cp "$CONF_SRC" "$CONF_DST"
echo "[coturn] config copied to $CONF_DST"

# Kill any running turnserver before relaunching
pkill -f turnserver 2>/dev/null || true
sleep 1

# Truncate the daily log (coturn appends date suffix to log-file path)
LOG_PATH="/var/log/turnserver_$(date +%Y-%m-%d).log"
: > "$LOG_PATH" 2>/dev/null || true

nohup turnserver -c "$CONF_DST" -o > /tmp/turn-stdout.log 2>&1 < /dev/null &
disown
sleep 2

if ss -lnup 2>/dev/null | grep -q ':3478'; then
    echo "[coturn] running. Listening on 127.0.0.1:3478"
    echo "[coturn] log: $LOG_PATH"
else
    echo "[coturn] FAILED to start — check $LOG_PATH" >&2
    exit 1
fi
