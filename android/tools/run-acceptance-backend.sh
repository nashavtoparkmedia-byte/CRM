#!/usr/bin/env bash
# Bring up a disposable CRM backend at THIS branch's revision, seeded with
# synthetic conversations, and print the matching APK build command.
#
# Why this exists: installing an APK adds no server routes. The mobile login
# and the notification gate live in the backend, so a shell pointed at a
# deployment that predates this branch will get 404s from both. Acceptance
# therefore needs a backend running this code, and production is out of scope.
#
# Everything here is disposable. It creates one container, one database and
# synthetic rows; it touches no production service and reads no production
# data. Re-running it resets the data.
#
# Usage:
#   bash android/tools/run-acceptance-backend.sh            # start
#   bash android/tools/run-acceptance-backend.sh --stop     # tear down
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
app="$repo/gravity-mvp"

container="yoko-acceptance-pg"
pg_port="55432"
app_port="3002"
node_bin="${YOKO_NODE_BIN:-/opt/codex-work/.toolchains/node-v20.20.2-linux-x64/bin}"

if [ "${1:-}" = "--stop" ]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
    echo "[acceptance] database removed. Stop the app with Ctrl+C in its terminal."
    exit 0
fi

export PATH="$node_bin:$PATH"
export DATABASE_URL="postgresql://acceptance:acceptance@127.0.0.1:${pg_port}/acceptance?schema=public"

# The mobile lane is closed unless this pair is provisioned, and there is no
# fallback to the project administrator credential. Override both before running
# if you want your own; the default is fine for a throwaway backend on a LAN.
export MOBILE_ACCESS_USER="${MOBILE_ACCESS_USER:-acceptance}"
export MOBILE_ACCESS_PASS="${MOBILE_ACCESS_PASS:-acceptance mobile passphrase}"

# Deliberately unset: with no SIP_WS_URL the softphone is off for everyone, so
# an acceptance run cannot produce a competing call client even by accident.
unset SIP_WS_URL || true

echo "[acceptance] revision $(git -C "$repo" rev-parse --short HEAD) on $(git -C "$repo" rev-parse --abbrev-ref HEAD)"

echo "[acceptance] starting database"
docker rm -f "$container" >/dev/null 2>&1 || true
docker run -d --name "$container" \
    -e POSTGRES_USER=acceptance \
    -e POSTGRES_PASSWORD=acceptance \
    -e POSTGRES_DB=acceptance \
    -p "127.0.0.1:${pg_port}:5432" \
    postgres:16-alpine >/dev/null
until docker exec "$container" pg_isready -U acceptance >/dev/null 2>&1; do sleep 1; done

echo "[acceptance] applying this branch's schema"
( cd "$app" && npx prisma db push --skip-generate --accept-data-loss >/dev/null )

echo "[acceptance] seeding synthetic conversations"
docker exec -i "$container" psql -U acceptance -d acceptance -X -q -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO "Chat" (id, channel, "externalChatId", name, status, "createdAt", "updatedAt", "chatType", "lastMessageAt")
VALUES
 ('acc_chat_tg_0001', 'telegram', 'telegram:acceptance-0001', 'Тест · Telegram', 'new', NOW(), NOW(), 'private', NOW()),
 ('acc_chat_wa_0002', 'whatsapp', 'whatsapp:acceptance-0002', 'Тест · WhatsApp', 'new', NOW(), NOW(), 'private', NOW()),
 ('acc_chat_max_0003', 'max',     'max:acceptance-0003',      'Тест · MAX',      'new', NOW(), NOW(), 'private', NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Message" (id, "chatId", direction, content, "createdAt", status)
VALUES
 ('acc_msg_0001', 'acc_chat_tg_0001', 'inbound',  'Здравствуйте, это тестовый диалог Telegram.', NOW(), 'delivered'),
 ('acc_msg_0002', 'acc_chat_tg_0001', 'outbound', 'Это тестовый ответ оператора.',               NOW(), 'delivered'),
 ('acc_msg_0003', 'acc_chat_wa_0002', 'inbound',  'Тестовое сообщение WhatsApp.',                NOW(), 'delivered'),
 ('acc_msg_0004', 'acc_chat_max_0003','inbound',  'Тестовое сообщение MAX.',                     NOW(), 'delivered')
ON CONFLICT (id) DO NOTHING;
SQL

lan_ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
lan_ip="${lan_ip:-127.0.0.1}"
origin="http://${lan_ip}:${app_port}"

cat <<EOF

[acceptance] backend ready

  origin for the phone : ${origin}
  mobile login user    : ${MOBILE_ACCESS_USER}
  seeded conversations : acc_chat_tg_0001, acc_chat_wa_0002, acc_chat_max_0003

Build the matching APK (the phone must be on this network):

  cd android
  YOKO_SHELL_KEYSTORE_PROPERTIES=<path> \\
    bash tools/bootstrap-gradle.sh :app:assembleAcceptance -PyokoTestOrigin=${origin}

  artifact: android/app/build/outputs/apk/acceptance/app-acceptance.apk

It installs alongside the production-origin build, not over it.

Starting the app in the foreground. Ctrl+C stops it; --stop removes the database.

EOF

cd "$app"
exec npx next dev -p "$app_port" -H 0.0.0.0
