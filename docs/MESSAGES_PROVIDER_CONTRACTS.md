# Messages Provider Contracts

## Уровни доказательств

- `CODE PASS` - проверена фактическая функция, route или service boundary.
- `MOCK PASS` - provider event/response воспроизведён sanitized fixture или mock.
- `REAL PROVIDER NOT TESTED` - в этом DEV-этапе не отправлялись реальные
  сообщения, реакции или медиа.

`MOCK PASS` никогда не означает production acceptance.

## Общие правила

Contact является источником истины, а provider identity доказывает канал.
При наличии provider message ID дедупликация выполняется только по нему.
Одинаковый текст с разными ID означает два сообщения. Content/time fingerprint
разрешён только для legacy-события без ID и для связывания provider echo с
оптимистичной исходящей CRM-строкой (`externalId=null`, `status=sent`).

HTTP 200 или запись `send_requested` не доказывают доставку. Реальная доставка
требует подтверждённого provider ID/ack/echo согласно контракту канала.

## MAX

Исходящий текст передаётся scraper одним полем `message`; CRM не режет его на
части. Входящий текст хранится в `Message.content`, а attachment, reply,
forwarding metadata и reactions остаются структурированными.

| Сценарий | Код | Fixture/mock | Реальный MAX |
| --- | --- | --- | --- |
| Повтор входящего текста с разными ID | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Повтор исходящего текста | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Текст без provider ID | CODE PASS: безопасно пропускается | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reconnect + catch-up | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Replay того же ID | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Image | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Image + caption | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| File | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reply inbound/outbound | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reaction outbound + provider echo | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Timeout | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Delayed echo | CODE PASS: остаётся unconfirmed | MOCK PASS | REAL PROVIDER NOT TESTED |
| Failed delivery | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Retry/backoff/budget | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |

Forensic старых искажённых текстов остаётся read-only:
`MAX_MESSAGE_FORENSIC.md`.

## Telegram

Стабильный ключ Contact identity - `telegramUserId`. Username и имя являются
изменяемыми наблюдениями и не используются для автоматического merge. Телефон
добавляется только из собственного shared contact или другого подтверждённого
источника.

Bot webhook передаёт `providerMessageId`, исходный provider timestamp и
`replyToProviderMessageId`. Bot message ID scoped по chat ID, потому что
Telegram Bot API message IDs не глобальны между чатами.

| Сценарий | Код | Fixture/mock | Реальный Telegram |
| --- | --- | --- | --- |
| Inbound/outbound | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Повтор текста с разными ID | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Username update при стабильном telegramUserId | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Собственный shared contact | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Чужой shared contact | CODE PASS: телефон не присваивается sender | MOCK PASS | REAL PROVIDER NOT TESTED |
| Media | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reply | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reaction where supported | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reconnect/webhook retry | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |

## WhatsApp

Телефон извлекается только из private `@c.us` JID. `@lid` является opaque
identity и не превращается в телефон. `@g.us` является group room, а не
телефоном участника.

| Сценарий | Код | Fixture/mock | Реальный WhatsApp |
| --- | --- | --- | --- |
| Private `@c.us` | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Opaque `@lid` | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Group `@g.us` | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Повтор текста с разными ID | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reconnect/history replay | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Media | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reply inbound/outbound | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Reaction inbound/outbound | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |
| Failed delivery retry | CODE PASS | MOCK PASS | REAL PROVIDER NOT TESTED |

`Нет связи` означает, что CRM сейчас не может выполнить WhatsApp Web
проверку. Это не ответ о наличии WhatsApp у клиента.

## Известные границы

- Реальные provider acceptance tests не выполнялись.
- Legacy-событие без provider ID нельзя безошибочно отличить от повторной
  доставки того же текста; применяется ограниченный fingerprint fallback.
- Recipient-side split MAX требует реального trace с provider message ID.
- Mock reconnect доказывает coalescing/backoff кода, но не качество внешней
  сети или provider session.
