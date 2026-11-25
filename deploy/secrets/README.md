# deploy/secrets/

Каталог содержит публичные ключи и локальные private runtime secrets, которые
не попадают в Git. См. `docs/SECRETS.md`.

## Что лежит здесь

- `age-public.key` — публичный age-ключ (получатель шифрования).
  Безопасно держать в git. Используется `backup-*.sh` для шифрования бэкапов.
- `telegram-bot.env` — credentials только для tg-bot: `BOT_TOKEN` и Xray proxy
  credentials. Держать с режимом `0600`; файл игнорируется Git. Google
  service-account JSON относится только к legacy Sheets/export и не является
  P0 runtime dependency.

## Что НИКОГДА не лежит здесь

- Приватный age-ключ — только в пасс-менеджере.
- Общий `.env.production` — в `.gitignore`, лежит в корне репозитория на VPS.
- SSH-ключи — у тебя локально и на VPS в `~/.ssh/`.

## Как сгенерировать age-пару

Один раз, локально:

```bash
age-keygen -o ~/age-key.txt
# В файле будет:
#   # created: 2026-06-09T...
#   # public key: age1abc...
#   AGE-SECRET-KEY-...
```

Public key (строка `age1...`) → положить в `deploy/secrets/age-public.key`.
Private key (`AGE-SECRET-KEY-...`) → пасс-менеджер + бумажная копия в сейф.
Файл `~/age-key.txt` после этого либо удалить, либо chmod 600.
