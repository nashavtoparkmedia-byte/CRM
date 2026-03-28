# MAX Web Protocol — Discovery Findings

> Заполняется вручную после сессии с discover.js
> Трейс: discovery/traces/trace.jsonl

---

## Статус

- [ ] Transport определён
- [ ] Incoming message event зафиксирован
- [ ] Send text endpoint найден
- [ ] Upload file endpoint найден
- [ ] Send media endpoint найден
- [ ] Auth token найден
- [ ] Stable IDs определены
- [ ] History capability оценена (Mode A / B / C)

---

## Transport

- Тип (WS / SSE / long-poll / fetch-stream):
- WebSocket URL (wss://...):
- Формат фреймов (JSON / protobuf / binary envelope):
- Есть ли отдельный канал для событий и для запросов:

---

## Incoming message event

Реальный JSON фрейм из ws_in / sse:

```json

```

Поля:
- message_id =
- from (user/phone/peer id) =
- text =
- timestamp =
- attachments =
- is_outgoing (поле или признак) =
- chat_id / dialog_id =

---

## Stable IDs

- Устойчивый ID сообщения:
- Устойчивый ID пользователя:
- Устойчивый ID диалога/чата:
- Что использовать как external_message_id:

---

## Auth token

- Хранится: localStorage / cookie / runtime memory
- Ключ / имя куки:
- Нужен явно в заголовке запросов: да / нет
- Как получить через page.evaluate():

---

## Send text

- METHOD:
- URL:
- Headers:
- Body:

```json

```

- Response:

```json

```

---

## Upload file

- METHOD:
- URL:
- Form fields (FormData):
- Response (file_id / token):

```json

```

---

## Send message with attachment

- METHOD:
- URL:
- Body:

```json

```

---

## History / Backfill

### Список чатов

- Endpoint есть: да / нет
- METHOD:
- URL:
- Формат ответа:

```json

```

- Пагинация по чатам: да / нет
- Параметры пагинации (cursor / offset / page):
- Stable chat/dialog id (что использовать):
- Можно получить без открытия чата в UI: да / нет

---

### История конкретного чата

- Endpoint есть: да / нет
- METHOD:
- URL:
- Параметры (chatId / cursor / before / offset / limit):
- Формат ответа:

```json

```

- Пагинация по сообщениям: да / нет
- Cursor / watermark — поле и формат:
- Можно листать до самого начала: да / нет
- Нужен ли чат открыт в UI для загрузки: да / нет
- Лимит глубины (дней / сообщений):
- Вложения и метаданные присутствуют в history response: да / нет

---

### Оценка capability (заполнить после анализа)

**Режим истории:**

- [ ] **Mode A — Full backfill**
  - есть список всех чатов
  - есть history endpoint по chatId с курсором
  - можно программно пройти всю доступную историю
  - → реализовать BackfillAllChatsJob

- [ ] **Mode B — Partial backfill**
  - есть список чатов
  - история ограничена (последние N сообщений или нужен открытый чат)
  - → реализовать RecentHistorySyncJob

- [ ] **Mode C — Live + recent only**
  - нет доступа к полной истории через сетевые вызовы
  - только live events + короткий кэш
  - → только live + catch-up при рестарте

**Обоснование выбора режима:**

---

## Gotchas / неочевидное

-

---

## Итоговые константы для TransportInterceptor.js

```javascript
// Заполнить после discovery — вставить в transport/TransportInterceptor.js

const ENDPOINTS = {
  sendText:    'METHOD URL',
  uploadFile:  'METHOD URL',
  sendMedia:   'METHOD URL',
  getHistory:  'METHOD URL',
  getChats:    'METHOD URL',
}

const WS_MESSAGE_TYPE_INCOMING = ''  // значение поля type для входящего сообщения

const AUTH = {
  storageKey: '',   // ключ в localStorage
  cookieName: '',   // имя куки (если через cookie)
  headerName: '',   // X-Auth-Token или другой (если нужен)
}

const STABLE_ID_FIELD = ''   // поле message_id в event payload
```
