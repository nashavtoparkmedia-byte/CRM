# Messages Provider Contracts

## Общие правила

Contact - источник истины, а provider identity - доказательство канала. Повтор
события определяется стабильным provider message ID и направлением, а не
одинаковым текстом. HTTP 200 сам по себе не означает доставку.

## MAX

Исходящий текст передаётся scraper одним полем `message`; CRM не режет его на
куски. Входящий текст сохраняется как `Message.content`, а медиа, reply и
reactions остаются отдельными структурированными данными. Forensic старых
искажённых текстов read-only: `MAX_MESSAGE_FORENSIC.md`.

## Telegram

Стабильный ключ - `telegramUserId`. Username и отображаемое имя изменяемы и не
участвуют в автоматическом merge. Номер добавляется только при реальном
подтверждённом источнике, а не по username или имени.

## WhatsApp

Для личного чата телефон можно извлечь только из private JID. Group JID не
является номером человека. `Нет связи` в интерфейсе означает, что CRM не
может проверить маршрут WhatsApp Web; это не ответ о наличии WhatsApp у
клиента.

## Регрессии

Транспорт, media, replies, reactions и delivery не менялись этим DEV RC.
Provider contract tests покрывают сохранение identity, текстовый pipeline и
представление reachability в интерфейсе.
