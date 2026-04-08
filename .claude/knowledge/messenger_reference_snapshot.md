# Messenger Reference Snapshot (March 20, 2026)

This document records the "known good" configuration of messengers as of 2026-03-20. Use this as a baseline when debugging connectivity issues.

## 📱 WhatsApp
- **Integration Page**: `http://localhost:3002/whatsapp`
- **Active Accounts**:
  - **Phone**: `+79221853150` | Status: Connected
  - **Phone**: `+79222155750` | Status: Connected
- **Notes**: Powered by `yandex-fleet-scraper` worker. Requires Chrome Profile 20 to be closed if running via worker.

## ✈️ Telegram
- **Integration Page**: `http://localhost:3002/telegram`
- **Active Accounts**:
  - **Account**: `Yoko3467` | **Phone**: `79226083467` | Status: Connected
  - **Account**: `default` | **Phone**: `+79222155750` | Status: Connected
- **Notes**: Managed by the `tg-bot` service. Uses `tg_bot_db` PostgreSQL database.

## 🤖 MAX (Yandex)
- **Integration Page**: `http://localhost:3002/max`
- **Active Bot**: `Бот поддержка Yoko`
- **Status**: Active (Type: Primary)
- **Token Pattern**: `f9LHodD0cO...`
- **Webhook**: `http://localhost:3002/api/webhooks/bot`

## ⚙️ Environment Configuration

Конфигурация каждого модуля хранится в соответствующем `.env` файле:
- `gravity-mvp/.env` — DATABASE_URL, SCRAPER_URL
- `tg-bot/.env` — BOT_TOKEN, CRM_WEBHOOK_URL
- `yandex-fleet-scraper/.env` — CHROME_USER_DATA_DIR, CHROME_PROFILE_DIR, CRM_WEBHOOK_URL

> [!IMPORTANT]
> Секреты и токены не хранятся в этом файле. Смотри `.env` файлы каждого модуля.
> If any of these channels show "Disconnected" in the UI while the services are running, check if the respective `.env` files match these settings and verify database connectivity.
