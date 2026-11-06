---
name: deploy-check
description: |
  Предзапусковая проверка — схема БД, .env, секреты в коде, build.
  TRIGGER: Запускать автоматически когда пользователь говорит про деплой, продакшн, релиз,
  "готов ли проект", или перед созданием PR в main.
  Также запускать после крупных изменений (новые миграции, новые env переменные, изменения schema.prisma).
user_invocable: true
---

# Deploy Check — Предзапусковая проверка

## Что делать

### 1. Проверить Prisma schema синхронизацию
```bash
cd gravity-mvp && npx prisma migrate status
```
- Если есть непримененные миграции — сообщить
- Если schema drift — предупредить

### 2. Проверить .env файлы
Для каждого модуля проверить наличие .env:
- `gravity-mvp/.env` — DATABASE_URL, ANTHROPIC_API_KEY (или через UI)
- `max-web-scraper/.env` — CRM_WEBHOOK_URL, порт
- `yandex-fleet-scraper/.env` — DATABASE_URL, REDIS_URL, порт
- `tg-bot/.env` — BOT_TOKEN, DATABASE_URL

Для каждого:
- Файл существует?
- Все обязательные переменные заполнены? (не пустые значения)
- Нет placeholder-ов типа "your-key-here"?

### 3. Поиск секретов в коде
Проверить что нет hardcoded секретов:
```
grep -r "sk-ant-" gravity-mvp/src/ max-web-scraper/ tg-bot/
grep -r "ghp_" gravity-mvp/src/ max-web-scraper/ tg-bot/
grep -r "password.*=.*['\"]" gravity-mvp/src/ --include="*.ts" --include="*.js"
```
Исключить .env файлы и node_modules.

### 4. Build проверка
```bash
cd gravity-mvp && npm run build
```
- Если ошибки — показать и предложить fix
- Если warnings — показать список

### 5. TypeScript проверка
```bash
cd gravity-mvp && npx tsc --noEmit
```
Показать ошибки типизации если есть.

### 6. Проверка зависимостей
Для каждого модуля:
```bash
npm audit --audit-level=high
```
Показать critical/high уязвимости.

### 7. Проверка известных проблем
- apiKeyEncrypted хранит plain text — предупредить
- $executeRaw вместо Prisma Client — показать количество мест
- KnowledgeBaseEntry пуста — предупредить если пуста

### 8. Отчёт

```
Deploy Readiness Check
═══════════════════════════
Prisma migrations:  ✅ Синхронизированы / ⚠️ Pending
.env файлы:         ✅ Все на месте / ❌ Отсутствуют: список
Секреты в коде:     ✅ Не найдены / ❌ Найдены: файлы
Build:              ✅ Успешен / ❌ Ошибки
TypeScript:         ✅ OK / ⚠️ N ошибок
Уязвимости:         ✅ Нет critical / ⚠️ N high
Известные проблемы: список
═══════════════════════════
Готовность к деплою: ✅ / ⚠️ / ❌
```
