# Backfill scripts — имена и телефоны контактов

Скрипты для подтягивания имён/телефонов в чаты, где они оказались placeholder.

## Что покрывают

| Скрипт | Канал | Источник | Когда работает |
|--------|-------|----------|----------------|
| `backfill_tg_names.js` | Telegram | MTProto через SOCKS5 proxy | Раз в неделю (cron) |
| `backfill_null_names_from_sibling.js` | WhatsApp | Sibling-чат с pushname | Раз в неделю (cron) |
| `backfill_from_linked.js` | TG + MAX | Driver.fullName / Contact.displayName | Раз в неделю (cron) |
| `backfill_all_weekly.bat` | все | runs all 3 above | — |
| `backfill_wa_names.js` | WhatsApp | externalChatId pattern | one-off, deprecated |
| `backfill_max_names.js` | MAX | Message.metadata.senderName | one-off, deprecated |
| `backfill_tg_via_bot_api.js` | TG | Bot API getChat | альтернатива (не работает для MTProto-ingest) |

## Setup еженедельный cron (Windows Task Scheduler)

```cmd
schtasks /create ^
  /tn "CRM Backfill Names Weekly" ^
  /tr "D:\Github\CRM\gravity-mvp\scripts\backfill_all_weekly.bat" ^
  /sc weekly /d SUN /st 03:00
```

Запуск каждое воскресенье в 03:00. Логи смотреть в Task Scheduler History.

## Запуск вручную

```bash
cd gravity-mvp
node scripts/backfill_tg_names.js [--dry-run]
node scripts/backfill_null_names_from_sibling.js [--dry-run]
node scripts/backfill_from_linked.js [--dry-run]
```

Или batch:
```cmd
scripts\backfill_all_weekly.bat
```

## Зависимости

- `backfill_tg_names.js` требует SOCKS5 proxy на `127.0.0.1:10808` (override
  через `TG_PROXY_PORT=10808`). Без proxy — `ETIMEDOUT 149.154.*`.
- TG Bot token читается из `../tg-bot/.env` (`BOT_TOKEN`).

## Корневые fix'ы (без необходимости backfill)

PR-Л автоматически вызывает sibling-lookup в `WhatsAppService` post-upsert —
новые WA-дубликаты сразу получают pushname. Backfill нужен только для
существующих "сирот" + миграции.

PR-М в TG webhook отбрасывает first_name='.' / '$$' и fallback на @username
— новые TG-чаты не создаются с placeholder-именем.
