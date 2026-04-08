---
name: project-map
description: |
  Полная структурная карта CRM проекта — скелет всех модулей, файлов и маршрутов.
  TRIGGER: Запускать автоматически В НАЧАЛЕ каждой новой сессии для ориентации.
  Также запускать когда нужно найти файл по функции ("где лежит логика задач?"),
  когда пользователь спрашивает "что где", "покажи структуру", "где это находится",
  или когда нужно понять куда добавить новый файл/компонент.
user_invocable: true
---

# Project Map — Структурная карта CRM

## Обзор

4 модуля, общая БД (PostgreSQL/Prisma), Windows.

| Модуль | Порт | Стек | Назначение |
|--------|------|------|------------|
| gravity-mvp | 3002 | Next.js 16, React 19, Prisma, Tailwind, shadcn | Центральная CRM — UI и API |
| max-web-scraper | 3005 | Node.js, Express, Playwright | Скрапер MAX мессенджера |
| tg-bot | 3001 | Node.js, Telegraf, Express, Prisma | Telegram бот + обработчики |
| tg-bot-frontend | 3004 | Next.js 14 | Админ-панель TG бота |
| yandex-fleet-scraper | env | Fastify, BullMQ, Playwright, Prisma | Скрапер Яндекс.Флот |

---

## gravity-mvp/ — Главная CRM

### Страницы (src/app/)
```
/                        → dashboard/          — Дашборд с KPI
/messages                → messages/           — Мессенджер (все каналы)
/tasks                   → tasks/              — Задачи (list/board/timeline)
/drivers                 → drivers/            — Список водителей
/drivers/[id]            → drivers/[id]/       — Карточка водителя + таймлайн
/drivers/archive         → drivers/archive/    — Архив водителей
/monitoring              → monitoring/         — Мониторинг событий
/analytics               → analytics/          — Аналитика (active-base, channels, churn, funnel)
/inbox                   → inbox/              — Входящие
/leads                   → leads/              — Лиды (new, in-progress, connected, no-orders)
/promotions              → promotions/         — Акции (active, efficiency, ending, history)
/communications          → communications/     — Шаблоны и авторассылки
/settings                → settings/           — Настройки
/settings/integrations/* → settings/integrations/ — Каналы (bot, max, telegram, whatsapp)
/settings/ai             → settings/ai/        — AI настройки
/settings/api            → settings/api/       — API ключи
/settings/triggers       → settings/triggers/  — Автотриггеры
/settings/scoring        → settings/scoring/   — Скоринг водителей
/settings/dictionaries   → settings/dictionaries/ — Справочники
/resources               → resources/          — Ресурсы (accounts, bindings, cars, numbers)
/control                 → control/            — Контроль (attention, churn-risk, launch-risk, no-orders)
/map                     → map/               — Карта
/logs                    → logs/              — Логи
/users                   → users/             — Пользователи системы
/login                   → login/             — Авторизация
```

### API маршруты (src/app/api/)
```
POST /api/webhooks/max          — Webhook от MAX скрапера (входящие сообщения)
POST /api/webhook/telegram      — Webhook от Telegram
POST /api/webhooks/bot          — Общий bot webhook
GET  /api/messages/conversations — Список чатов
POST /api/messages              — Отправка сообщений
POST /api/messages/send-image   — Отправка изображений
POST /api/messages/start-chat   — Создание чата
GET  /api/messages/drivers/[id]/channels — Каналы водителя
GET  /api/messages/drivers/search — Поиск водителей
GET  /api/messages/profiles     — Профили
GET  /api/drivers-search        — Поиск водителей
GET  /api/monitoring/drivers    — Водители для мониторинга
POST /api/monitoring/drivers/[id]/event — Событие
GET  /api/monitoring/drivers/[id]/events — История событий
POST /api/monitoring/drivers/[id]/fleet-check — Проверка флота
POST /api/monitoring/drivers/[id]/attention — Внимание
GET  /api/monitoring/attention   — Список на внимании
POST /api/monitoring/sync        — Синхронизация
POST /api/monitoring/fleet-check/callback — Коллбэк проверки
POST /api/channels/accounts     — Управление каналами
GET  /api/cron/init-telegram    — Инициализация TG бота
GET  /api/cron/sync-scraper     — Синхронизация скрапера
GET  /api/cron/sync-trips       — Синхронизация поездок
GET  /api/import-jobs/[id]      — Статус импорта
GET  /api/debug-db/*            — Отладка БД (cleanup-chats, find-message, force-sync, etc.)
```

### Библиотеки (src/lib/)
```
prisma.ts                 — Singleton Prisma Client
utils.ts                  — Утилиты
scoring.ts                — Скоринг и сегментация водителей
communications.ts         — Логика коммуникаций
triggers.ts               — Движок триггеров
messageEvents.ts          — Система событий сообщений (emitMessageReceived)
DriverMatchService.ts     — Нормализация телефонов, сопоставление водителей
MessageService.ts         — Доставка и очередь сообщений
YandexFleetService.ts     — Интеграция с Яндекс.Флот API
WhatsAppService.ts        — WhatsApp интеграция

pipeline/                 — AI pipeline (Блок 3-4)
  ContextBuilder.ts       — Собирает контекст: config, чат, водитель, KB, история
  IntentClassifier.ts     — Anthropic classify → intent, confidence, matchedKbEntryId
  DecisionEngine.ts       — auto_reply / escalate / skip
  ResponseGenerator.ts    — Anthropic generate → отправка через адаптеры
  PipelineWorker.ts       — Оркестратор pipeline + запись в AiDecisionLog
  ChannelAdapterRegistry.ts — Адаптеры MAX / Telegram / WhatsApp

dictionaries/
  dictionary-service.ts   — CRUD справочников

tasks/
  task-event-service.ts   — Аудит задач
  types.ts                — Типы задач

users/
  user-service.ts         — Управление пользователями

whatsapp/
  WhatsAppService.ts      — WhatsApp API обёртка
```

### Компоненты (src/components/)
```
ui/                       — shadcn: button, input, card, badge, table, tabs, tooltip, EmptyState, PageContainer
layout/                   — PageHeader, PageShell, TopBar
messenger/                — Messenger.tsx (главный чат UI)
NeumorphicCard.tsx        — Неоморфная карточка
NeumorphicButton.tsx      — Неоморфная кнопка
NeumorphicInput.tsx       — Неоморфный инпут
```

### Стейт и хуки
```
store/tasks-store.ts      — Zustand стор задач
store/tasks-selectors.ts  — Селекторы задач
hooks/use-tasks-query.ts  — React Query для задач
hooks/use-task-mutations.ts — Мутации задач
```

### Prisma схема (prisma/schema.prisma)
```
Driver, DriverMax, Chat, Message, MessageEventLog, AiDecisionLog,
AiAgentConfig, KnowledgeBaseEntry, Task, TaskEvent,
TelegramConnection, MaxConnection, MaxPersonalSession, WhatsAppConnection,
ApiConnection, ApiLog
```

---

## max-web-scraper/ — MAX скрапер

```
index.js                  — Express сервер + Playwright оркестрация
maxBrowser.js             — DOM автоматизация MAX web app (50KB, основной файл)

contacts/ContactStore.js  — Имена и телефоны (opcode 32)
discovery/discover.js     — Автообнаружение чатов
media/MediaPipeline.js    — Скачивание вложений
parser/MessageParser.js   — Raw WS → CRM payload
session/SessionController.js — QR логин, сессия
sync/MessageSync.js       — Live sync + dedup кэш
sync/InitialHistorySync.js — Backfill истории
transport/TransportInterceptor.js — CDP + WS перехват

known_chats.json          — Кэш списка чатов
last_seen_dedupe.json     — Дедупликация
```

---

## tg-bot/ — Telegram бот

### Backend (src/)
```
bot.js                    — Telegraf инстанс
app.js                    — Express API
config.js                 — Конфигурация
database.js               — Инициализация БД
start.js                  — Запуск

handlers/
  start.js                — /start команда
  menu.js                 — Навигация меню
  survey.js               — Сцена опроса
  dynamicSurvey.js        — Динамический опрос
  connection.js           — Связка с CRM
  carManagement.js        — Управление авто
  balanceLimit.js         — Баланс/лимиты
  admin.js                — Админ-команды

routes/
  webhooks.js             — Telegram вебхуки
  crm.js                  — CRM интеграция
  admin/index.js          — Роутер админки
  admin/bots.js           — Управление ботами
  admin/surveys.js        — CRUD опросов
  admin/users.js          — Пользователи
  admin/analytics.js      — Аналитика
  admin/dashboard.js      — Дашборд

services/
  telegramService.js      — Telegram API обёртка
  userService.js          — Юзер-сервис
  crmIntegration.js       — CRM интеграция
  crmHealth.js            — Здоровье CRM
  sheets.js               — Google Sheets экспорт
  analytics.js            — Аналитика
```

### Frontend (tg-bot-frontend/) — Next.js 14, порт 3004
```
pages/
  index.js                — Дашборд
  login.js                — Логин
  bots.js                 — Список ботов
  bots/[id].js            — Детали бота
  surveys/index.js        — Опросы
  surveys/[id].js         — Редактор опроса
  users/index.js          — Пользователи
  users/[id].js           — Профиль пользователя

components/
  Header.js, Sidebar.js, Layout.js, CustomSelect.js

context/AuthContext.js    — Авторизация
lib/api.js                — API клиент
```

### Prisma (prisma/schema.prisma)
```
Bot, Survey, Question, User, Answer, AnalyticsEvent, Broadcast
```

---

## yandex-fleet-scraper/ — Скрапер Яндекс.Флот

```
src/
  api.ts                  — Fastify API сервер (scrape, status, metrics endpoints)
  worker.ts               — BullMQ воркер + Playwright
  lib/parser.ts           — Парсинг ответов Яндекс
  lib/encryption.ts       — Шифрование учёток
  scripts/login.ts        — Авторизация в Яндекс
  scripts/heal-account.ts — Восстановление аккаунта

prisma/schema.prisma      — Account, ScrapingJob, DriverTrip
```

Scripts: `start:api`, `start:worker`, `login`, `test`

---

## Корень проекта

```
CLAUDE.md                 — Инструкции для Claude
start-all.bat             — Запуск всех 4 модулей
.agents/knowledge/
  max_chat_merging.md     — Anti-Ghost логика MAX
  messenger_reference_snapshot.md — Референс мессенджера
.agents/workflows/
  start-all.md            — Документация запуска
.claude/skills/           — Авто-скиллы Claude
```

---

## Поток данных

```
Yandex Fleet → yandex-fleet-scraper → PostgreSQL (trips)
MAX Web App  → max-web-scraper → POST /api/webhooks/max → gravity-mvp → Message + Chat + MessageEventLog
Telegram     → tg-bot → POST /api/webhook/telegram → gravity-mvp → Message + Chat
WhatsApp     → whatsapp-web.js → gravity-mvp → Message + Chat

MessageEventLog (pending) → PipelineWorker → IntentClassifier → DecisionEngine → ResponseGenerator → AiDecisionLog
                                                                                     ↓
                                                                              ChannelAdapterRegistry → MAX/TG/WA
```
