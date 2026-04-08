---
name: migrate-raw-to-prisma
description: |
  Конвертация $executeRaw вызовов в типизированные Prisma Client запросы.
  TRIGGER: Запускать автоматически когда пользователь просит навести порядок в коде,
  убрать тех-долг, или когда prisma generate наконец проходит успешно
  (значит EPERM больше не блокирует и можно мигрировать).
user_invocable: true
---

# Migrate Raw to Prisma — Миграция с $executeRaw на Prisma Client

## Контекст
Из-за EPERM ошибки (DLL заблокирован запущенным Node.js) все новые таблицы используют `$executeRaw` вместо Prisma Client. Это работает, но нет типизации и автокомплита.

## Что делать

### 1. Найти все $executeRaw вызовы
Поиск по проекту:
```
grep -rn '\$executeRaw\|\$queryRaw' gravity-mvp/src/ --include="*.ts" --include="*.js"
```
Для каждого найденного места записать:
- Файл и строку
- SQL запрос
- Какая таблица/модель используется

### 2. Проверить Prisma schema
Прочитать `gravity-mvp/prisma/schema.prisma`.
Для каждой таблицы из шага 1 проверить:
- Есть ли модель в schema?
- Все ли поля описаны?
- Если модели нет — нужно добавить

### 3. Попробовать prisma generate
```bash
cd gravity-mvp && npx prisma generate
```
- Если EPERM — предупредить: "Нужно остановить Next.js dev server перед генерацией"
- Если OK — продолжить миграцию

### 4. Для каждого $executeRaw создать Prisma эквивалент

Примеры преобразований:
```typescript
// БЫЛО:
await prisma.$executeRaw`INSERT INTO "MessageEventLog" ...`
// СТАЛО:
await prisma.messageEventLog.create({ data: { ... } })

// БЫЛО:
await prisma.$queryRaw`SELECT * FROM "AiDecisionLog" WHERE ...`
// СТАЛО:
await prisma.aiDecisionLog.findMany({ where: { ... } })

// БЫЛО:
await prisma.$executeRaw`UPDATE "MessageEventLog" SET status = 'processing' WHERE status = 'pending'`
// СТАЛО:
await prisma.messageEventLog.updateMany({ where: { status: 'pending' }, data: { status: 'processing' } })
```

### 5. Особый случай: атомарный захват в PipelineWorker
```sql
UPDATE "MessageEventLog" SET status='processing' WHERE id=$1 AND status='pending'
```
Этот паттерн НЕ ИМЕЕТ прямого Prisma эквивалента (нет atomic WHERE в update).
Варианты:
- Оставить $executeRaw (рекомендуется для атомарности)
- Использовать prisma.$transaction с optimistic locking

Спросить пользователя какой вариант предпочитает.

### 6. Применить изменения
- Для каждого файла показать diff до/после
- Спросить подтверждение перед применением
- После применения — запустить `npm run build` для проверки

### 7. Отчёт

```
$executeRaw → Prisma Client Migration
═══════════════════════════════════════
Найдено $executeRaw:  N мест в M файлах
Мигрировано:          N
Оставлено (атомарные): N
Ошибки:               N
Build после миграции: ✅ / ❌
```

## Важно
- НЕ менять атомарный UPDATE WHERE без согласия пользователя
- Перед миграцией убедиться что prisma generate прошёл успешно
- Тестировать каждое изменение отдельно
