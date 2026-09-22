-- Synthetic conversations for Android shell acceptance.
--
-- Every value here is invented. There is no real contact, no real phone number
-- and no real external identifier: the external ids are literal "acceptance"
-- strings that no provider will ever match, so nothing seeded can be delivered
-- to anyone even if a transport were configured by mistake.
--
-- One conversation, «Тест · Ответ MAX», is a reply target. A send from it must
-- pass the same Contacts identity and conversation binding checks as a real
-- reply, so it is a private MAX chat bound to a synthetic Contact and
-- ContactIdentity, with the max_scraper connection, a synthetic provider id and
-- sender, and a synthetic conversation target. Its only reachable transport is
-- the loopback acceptance stand-in the workflow starts, which accepts nothing
-- but these exact synthetic values.
--
-- Applied only by android/tools/run-acceptance-backend.sh, against the
-- disposable container it creates on the loopback interface. It is never run
-- against a shared database.

INSERT INTO "Chat" (
    id, channel, "externalChatId", name, status,
    "createdAt", "updatedAt", "chatType", "lastMessageAt"
)
VALUES
    ('acc_chat_tg_0001', 'telegram', 'telegram:acceptance-0001', 'Тест · Telegram', 'new', NOW(), NOW(), 'private', NOW()),
    ('acc_chat_wa_0002', 'whatsapp', 'whatsapp:acceptance-0002', 'Тест · WhatsApp', 'new', NOW(), NOW(), 'private', NOW()),
    ('acc_chat_max_0003', 'max', 'max:acceptance-0003', 'Тест · MAX', 'new', NOW(), NOW(), 'private', NOW())
ON CONFLICT (id) DO NOTHING;

-- updatedAt has no default in the migrated schema, and channel must match the
-- conversation or the channel tabs disagree with the chat they belong to.
INSERT INTO "Message" (
    id, "chatId", direction, channel, content, status, "createdAt", "updatedAt"
)
VALUES
    ('acc_msg_0001', 'acc_chat_tg_0001', 'inbound', 'telegram', 'Здравствуйте, это тестовый диалог Telegram.', 'delivered', NOW(), NOW()),
    ('acc_msg_0002', 'acc_chat_tg_0001', 'outbound', 'telegram', 'Это тестовый ответ оператора.', 'delivered', NOW(), NOW()),
    ('acc_msg_0003', 'acc_chat_wa_0002', 'inbound', 'whatsapp', 'Тестовое сообщение WhatsApp.', 'delivered', NOW(), NOW()),
    ('acc_msg_0004', 'acc_chat_max_0003', 'inbound', 'max', 'Тестовое сообщение MAX.', 'delivered', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Contact" (id, "displayName", "createdAt", "updatedAt")
VALUES
    ('acc_contact_max_0005', 'Тест · Ответ MAX', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;

INSERT INTO "ContactIdentity" (id, "contactId", channel, "externalId", "displayName", "createdAt")
VALUES
    ('acc_identity_max_0005', 'acc_contact_max_0005', 'max', 'acceptance-max-sender-0005', 'Тест · Ответ MAX', NOW())
ON CONFLICT (id) DO NOTHING;

-- The private-conversation, connection, provider and sender fields are exactly
-- what the outbound binding check compares; the target "acceptance-000000000005"
-- reaches the transport as the digits 000000000005.
INSERT INTO "Chat" (
    id, channel, "externalChatId", name, status,
    "createdAt", "updatedAt", "chatType", "lastMessageAt",
    "contactId", "contactIdentityId", metadata
)
VALUES
    ('acc_chat_max_0005', 'max', 'max:acceptance-000000000005', 'Тест · Ответ MAX', 'new',
     NOW(), NOW(), 'private', NOW(),
     'acc_contact_max_0005', 'acc_identity_max_0005',
     '{"chatKind": "private", "connectionId": "max_scraper", "providerAccountId": "acceptance-max-provider-0005", "senderId": "acceptance-max-sender-0005"}')
ON CONFLICT (id) DO NOTHING;

INSERT INTO "Message" (
    id, "chatId", direction, channel, content, status, "createdAt", "updatedAt"
)
VALUES
    ('acc_msg_0005', 'acc_chat_max_0005', 'inbound', 'max', 'Можно уточнить время смены?', 'delivered', NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
