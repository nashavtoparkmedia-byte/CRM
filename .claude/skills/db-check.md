---
name: db-check
description: |
  Быстрый дамп состояния БД — статистика таблиц, последние записи, состояние pipeline.
  TRIGGER: Запускать автоматически когда нужно понять текущее состояние данных —
  при отладке сообщений (куда ушло, дошло ли), при проверке результатов миграций,
  когда пользователь спрашивает "что в базе" / "сколько записей" / "последние сообщения",
  или при расследовании почему AI не отвечает (проверить pending events, KB состояние).
user_invocable: true
---

# DB Check — Состояние базы данных

## Что делать

Создать и запустить скрипт `scripts/db_check.js` в `gravity-mvp/`. Скрипт подключается через Prisma и выводит сводку.

### Запросы:

#### 1. Общая статистика
```sql
SELECT 'Driver' as table_name, COUNT(*) as count FROM "Driver"
UNION ALL SELECT 'Chat', COUNT(*) FROM "Chat"
UNION ALL SELECT 'Message', COUNT(*) FROM "Message"
UNION ALL SELECT 'MessageEventLog', COUNT(*) FROM "MessageEventLog"
UNION ALL SELECT 'AiDecisionLog', COUNT(*) FROM "AiDecisionLog"
UNION ALL SELECT 'KnowledgeBaseEntry', COUNT(*) FROM "KnowledgeBaseEntry"
UNION ALL SELECT 'Task', COUNT(*) FROM "Task"
```

#### 2. Pipeline статус
```sql
SELECT status, COUNT(*) FROM "MessageEventLog" GROUP BY status
```
Показать сколько pending, processing, processed, failed.

#### 3. Последние 5 сообщений
```sql
SELECT m.id, m."text", m."createdAt", c."channelType", c."externalChatName"
FROM "Message" m JOIN "Chat" c ON m."chatId" = c.id
ORDER BY m."createdAt" DESC LIMIT 5
```

#### 4. Последние AI решения
```sql
SELECT intent, confidence, decision, "createdAt"
FROM "AiDecisionLog" ORDER BY "createdAt" DESC LIMIT 5
```

#### 5. Состояние KnowledgeBase
```sql
SELECT category, COUNT(*) FROM "KnowledgeBaseEntry" GROUP BY category
```
Если пусто — предупредить: "KB пуста — AI будет всё эскалировать"

#### 6. Состояние каналов
```sql
SELECT "channelType", COUNT(*) FROM "Chat" GROUP BY "channelType"
```

### Формат вывода

Краткая таблица с числами. Без лишних деталей. Если есть failed записи в pipeline — выделить красным и показать ошибки.

### После проверки
Удалить временный скрипт.
