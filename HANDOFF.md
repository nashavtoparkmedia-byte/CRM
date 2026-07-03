# CRM — Handoff / Аудит проекта

> Документ для передачи проекта (в т.ч. агенту Codex). Описывает архитектуру,
> git, деплой и операции. **Секретов здесь нет** — только карта, где они лежат.
> Полный список паролей/ключей — в отдельном защищённом файле у владельца
> (см. раздел «Секреты» ниже). Инструкции для агента — в `AGENTS.md` / `CLAUDE.md`.
>
> Составлено: 2026-07-03.

---

## 1. Что это за проект

Внутренняя CRM для управления водителями и аналитики (NashAvtoParkMedia).
Мультиканальный обмен сообщениями (WhatsApp / Telegram / MAX / Avito), телефония
(SIP + AI-обзвон), скрапинг Yandex.Fleet, опросы водителей через Telegram-бота.

**Стек:** TypeScript + JavaScript, Node.js, Next.js, Prisma ORM, PostgreSQL, Redis,
Playwright, Docker Compose, nginx. Разработка — на Windows.

**Прод-домен:** https://yokoone.ru (админка опросов — https://admin.yokoone.ru).

---

## 2. Модули и порты

| Модуль | Папка | Стек | Порт | Назначение |
|--------|-------|------|------|------------|
| CRM (ядро) | `gravity-mvp/` | Next.js 16, React 19, Prisma, Tailwind | 3002 | UI, API, pipeline сообщений, AI, телефония |
| MAX Scraper | `max-web-scraper/` | Node, Express, Playwright | 3005 | Скрапер мессенджера MAX (CDP + WS) |
| TG Bot | `tg-bot/` | Node, Telegraf, Express, Prisma | 3001 | Telegram-бот водителей + хендлеры |
| TG Bot Frontend | `tg-bot/tg-bot-frontend/` | Next.js 14 | 3004 | Админка бота |
| Yandex Scraper API | `yandex-fleet-scraper/` | Fastify, BullMQ, Playwright | 3003 | API скрапера Yandex.Fleet |
| Yandex Scraper Worker | `yandex-fleet-scraper/` | BullMQ worker | — | Playwright-воркер проверок |
| Avito Worker | `avito-worker/` | Node | — | Приём лидов Avito (отключён в проде) |
| Audio Bridge | `tools/audio-bridge-day1/` | Node | 3030 | Мост FreeSWITCH ↔ STT/TTS для AI-обзвона |
| Телефония | `telephony/`, хост VPS | FreeSWITCH, coturn, xray | SIP/RTP | Голос (на хосте, НЕ в Docker) |

**Локальный запуск всего:** `start-all.bat` в корне. Порядок и команды — в `CLAUDE.md` / `AGENTS.md`.

---

## 3. Git

- **Origin:** `https://github.com/nashavtoparkmedia-byte/CRM`
- **Основная ветка:** `main`
- **Текущая рабочая ветка:** `feature/ai-knowledge-core`
- **Внимание:** на рабочей ветке есть **незакоммиченные изменения** и множество
  untracked временных скриптов в `gravity-mvp/scripts/` (диагностика MAX/TG/WA/Yandex).
  Перед передачей стоит либо закоммитить нужное, либо вычистить (`git status`).
- Много feature/claude/wip веток на remote — история экспериментов. Актуальная работа — на `feature/ai-knowledge-core` и `main`.

---

## 4. Где задеплоено

| Параметр | Значение |
|----------|----------|
| **Провайдер** | Beget VPS (4 vCPU / 8 GB RAM / 80 GB SSD, Ubuntu 22.04) |
| **IP** | `155.212.130.14` |
| **SSH** | `ssh -i ~/.ssh/yokoone_vps root@155.212.130.14` (пользователь **root**) |
| **Путь на VPS** | `/opt/crm` |
| **Compose-файл** | `deploy/docker-compose.production.yml` |
| **Env на VPS** | `/opt/crm/.env.production` (в git НЕ идёт; шаблон — `.env.production.example`) |
| **Домены** | yokoone.ru, www., app., admin. (Let's Encrypt через nginx-контейнер) |

### Docker-сервисы на проде (из compose)
`postgres`, `redis`, `minio` (+`minio-init`), `freeswitch`, `audio-bridge`,
`certs-init`, `nginx`, `gravity-mvp`, `tg-bot`, `tg-bot-frontend`,
`yandex-fleet-scraper-api`, `yandex-fleet-scraper-worker`, `max-web-scraper`.

**На хосте (НЕ в Docker):** FreeSWITCH, coturn, xray — голосовой трафик и SOCKS-прокси.

### Команды деплоя (из `/opt/crm`)
```bash
git pull
docker compose --env-file .env.production -f deploy/docker-compose.production.yml build gravity-mvp
docker compose --env-file .env.production -f deploy/docker-compose.production.yml up -d --force-recreate gravity-mvp
```
- Без `--env-file .env.production` compose падает (обязательные переменные).
- Готовый скрипт: `scripts/deploy.sh`.
- Миграции: Dockerfile CMD = `prisma migrate deploy`. Новые модели — только через
  `prisma migrate dev` локально, НЕ `db push` (иначе schema drift).

### Грабли деплоя (задокументированы, реальные инциденты)
1. `docker restart` НЕ применяет новый образ → всегда `up -d --force-recreate`.
2. Build-cache может молча собрать старый `.next` → проверять бандл `docker exec ... grep`, при сомнении `build --no-cache`.
3. Клиентский `fetch("http://localhost:PORT")` мёртв на проде → использовать same-origin прокси-роуты.
4. Next.js `rewrites()` = build-time, рантайм-env не влияет → пробрасывать через `ARG/ENV` в Dockerfile.
5. nginx кэширует IP контейнеров → `resolver 127.0.0.11` + force-recreate nginx.
6. Билды Next.js тяжёлые для VPS → не запускать 2 сборки параллельно.

---

## 5. Инфраструктура и данные

- **PostgreSQL** (Docker) — единая БД `tg_bot_db`. Схема: `gravity-mvp/prisma/schema.prisma`.
  Ключевые сущности: Contact, ContactIdentity, Chat, Message, Driver. Порт наружу закрыт.
- **Redis** (Docker) — очередь задач скрапера + кэш.
- **MinIO** (Docker) — S3-совместимое хранилище записей звонков (`recordings`).
- **Selectel Object Storage** — offsite бэкапы (Postgres, профили браузеров, зашифрованные `.env`).
- **Каналы:** WhatsApp (whatsapp-web.js + Puppeteer, сессия в volume `gravity_whatsapp`),
  Telegram (GramJS), MAX (Playwright-скрапер), Avito (webhook, выключен).

### Бэкапы (скрипты в `scripts/`)
| Что | Когда | Скрипт |
|-----|-------|--------|
| Postgres dump | ежедневно 03:00 | `backup-pg.sh` |
| Профили браузеров | ежедневно 03:30 | `backup-files.sh` |
| `.env` (age-шифр) | после изменений | `backup-env.sh` |
| Записи звонков | write-through | внутри сервисов |

Восстановление: `restore-pg.sh`, `restore-files.sh`, `restore-test.sh`.
Мониторинг: `health-monitor.sh` (cron раз в минуту → алерты в `@yoko_park_bot`).

---

## 6. Секреты — где лежат (значений здесь НЕТ)

- **Правило:** ни один секрет не в git. `.gitignore` исключает `**/.env*`, `*.key`, `*.pem`, `*.age`
  (исключение — публичный `deploy/secrets/age-public.key`).
- **Локальные `.env`** (на машине разработчика, gitignored): в корне каждого модуля —
  `gravity-mvp/.env`, `tg-bot/.env`, `yandex-fleet-scraper/.env`, `max-web-scraper/.env`,
  `avito-worker/.env`, `tools/audio-bridge-day1/.env`.
- **Прод-секреты:** только `/opt/crm/.env.production` на VPS + зашифрованная (age) копия в Selectel S3.
- **Карта секретов (что где используется, без значений):** `docs/SECRETS.md`.
- **Шаблон прод-env:** `.env.production.example` (все нужные переменные с плейсхолдерами).
- **Полный список реальных значений для передачи** — в отдельном защищённом файле у владельца
  (`CREDENTIALS_HANDOFF.md`, вне репозитория). Запросить у владельца; в git не помещать.
- **Только в пасс-менеджере владельца:** root-пароль VPS, SSH private key, GitHub-доступ,
  age PRIVATE key, аккаунты Beget/Selectel/Anthropic/МультиФон/регистратора домена.

---

## 7. Инструкции для агента

- **Codex:** `AGENTS.md` (в корне) — правила, безопасные команды, дизайн-система.
- **Claude Code:** `CLAUDE.md` — то же самое для Claude.
- **База знаний интеграций:** `.claude/knowledge/` (например `max_chat_merging.md`).
- **MCP:** `.mcp.json` (Claude), `.codex/config.toml` (Codex) — context7 + postgres.
- **Прочие доки:** `docs/DEPLOY.md`, `docs/operations/`, `docs/design/`, `PROJECT_STRUCTURE.md`, `.cursorrules`.

---

## 8. Открытые вопросы / технический долг

- **Исходящая телефония через Мегафон не работает:** SBC МультиФон фильтрует хостинг-IP VPS.
  Решение — whitelist IP `155.212.130.14` в кабинете МультиФон Бизнес, либо другой VoIP
  (Zadarma доказанно доступна с VPS). Входящая регистрация софтфона работает.
- **Незакоммиченные изменения** на `feature/ai-knowledge-core` + много временных скриптов — прибрать.
- **AI Knowledge Core** — модуль в разработке (PR1 сделан, дальше PR2 extraction pipeline).
- **Avito-парсер** отключён в проде (экономия ресурсов), код ещё ждёт переменные.
- Мелкие незакрытые: `AiControlCenterClient.tsx` import-progress через `NEXT_PUBLIC_MAX_SCRAPER_URL` (localhost на проде).
