---
name: health
description: |
  Автоматическая проверка здоровья всех сервисов CRM.
  TRIGGER: Запускать автоматически ПЕРЕД любой задачей, которая требует работающих сервисов —
  отправка сообщений, тесты pipeline, отладка webhook, работа с БД через API.
  Также запускать когда получаешь connection refused, ECONNREFUSED, timeout или 500 от любого сервиса.
user_invocable: true
---

# Health — Проверка здоровья всех сервисов

## Что делать

Создать и запустить скрипт `scripts/health_check.js` в корне проекта. Скрипт должен проверить все компоненты и вывести результат.

### Проверки:

#### 1. CRM (Next.js) — порт 3002
```js
fetch('http://localhost:3002').then(r => ({ status: r.status, ok: r.ok }))
```

#### 2. MAX Web Scraper — порт 3005
```js
fetch('http://localhost:3005').then(r => ({ status: r.status, ok: r.ok }))
```
Также проверить `/status` endpoint если есть.

#### 3. Yandex Fleet Scraper API
Проверить стандартный порт scraper API (найти в .env или конфиге yandex-fleet-scraper).

#### 4. База данных (PostgreSQL через Prisma)
```js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
await p.$queryRaw`SELECT 1 as ok`;
```

#### 5. Redis (для BullMQ)
Проверить подключение к Redis если используется yandex-fleet-scraper.

### Формат вывода

```
╔══════════════════════════════════════╗
║        CRM Health Check              ║
╠══════════════════════════════════════╣
║ CRM (3002)          ✅ OK / ❌ DOWN  ║
║ MAX Scraper (3005)  ✅ OK / ❌ DOWN  ║
║ Scraper API         ✅ OK / ❌ DOWN  ║
║ PostgreSQL          ✅ OK / ❌ DOWN  ║
║ Redis               ✅ OK / ❌ DOWN  ║
╚══════════════════════════════════════╝
```

Если сервис недоступен — показать какой командой его запустить (из CLAUDE.md).

### После проверки
- Удалить временный скрипт
- Если всё ОК — одна строка "All services healthy"
- Если что-то упало — список команд для запуска недостающих сервисов
