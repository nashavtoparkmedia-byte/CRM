---
name: test-pipeline
description: |
  End-to-end тест AI message pipeline — от webhook до AiDecisionLog.
  TRIGGER: Запускать автоматически ПОСЛЕ любых изменений в файлах pipeline
  (ContextBuilder, IntentClassifier, DecisionEngine, ResponseGenerator, PipelineWorker, ChannelAdapterRegistry),
  после изменений в webhook route, после добавления записей в KnowledgeBaseEntry,
  или после изменений в AiAgentConfig.
user_invocable: true
---

# Test Pipeline — End-to-end тест AI pipeline

## Что делать

### 1. Проверить что сервисы запущены
- Проверить доступность CRM на порту 3002 (curl http://localhost:3002)
- Проверить доступность MAX scraper на порту 3005 (curl http://localhost:3005)
- Если что-то не отвечает — сообщить пользователю и остановиться

### 2. Проверить конфигурацию AI
- Прочитать AiAgentConfig из БД через скрипт:
  ```js
  const { PrismaClient } = require('@prisma/client');
  const p = new PrismaClient();
  p.$queryRaw`SELECT * FROM "AiAgentConfig" LIMIT 1`.then(r => { console.log(JSON.stringify(r, null, 2)); p.$disconnect(); });
  ```
- Проверить что apiKeyEncrypted не пустой
- Если ключа нет — сообщить: "API ключ Anthropic не настроен. Вставь его в Settings → AI"

### 3. Отправить тестовое сообщение через MAX webhook
- Создать скрипт `scripts/test_pipeline.js` в gravity-mvp:
  ```js
  const testPayload = {
    chatId: 'test-pipeline-' + Date.now(),
    senderId: 'test-driver',
    senderName: 'Тест Водитель',
    text: 'Здравствуйте, когда будет следующая выплата?',
    timestamp: new Date().toISOString(),
    source: 'max'
  };

  fetch('http://localhost:3002/api/webhooks/max', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testPayload)
  })
  .then(r => r.json())
  .then(d => console.log('Webhook response:', JSON.stringify(d, null, 2)))
  .catch(e => console.error('Webhook error:', e.message));
  ```
- Запустить: `node scripts/test_pipeline.js`

### 4. Проверить MessageEventLog
- Подождать 3 секунды
- Запросить последние записи:
  ```js
  p.$queryRaw`SELECT * FROM "MessageEventLog" ORDER BY "createdAt" DESC LIMIT 5`
  ```
- Проверить что тестовое сообщение появилось со статусом pending → processing → processed

### 5. Проверить AiDecisionLog
- Запросить:
  ```js
  p.$queryRaw`SELECT * FROM "AiDecisionLog" ORDER BY "createdAt" DESC LIMIT 5`
  ```
- Показать: intent, confidence, decision (auto_reply/escalate/skip), generatedResponse

### 6. Отчёт
Вывести краткую таблицу:
| Шаг | Статус |
|-----|--------|
| CRM доступен | ✅/❌ |
| API ключ настроен | ✅/❌ |
| Webhook принял сообщение | ✅/❌ |
| MessageEventLog записан | ✅/❌ |
| Pipeline обработал | ✅/❌ |
| AiDecisionLog заполнен | ✅/❌ |
| Intent/Decision | значение |

Если что-то сломалось — показать ошибку и предложить fix.

### 7. Очистка
Удалить тестовые записи из MessageEventLog и AiDecisionLog (спросить пользователя).
