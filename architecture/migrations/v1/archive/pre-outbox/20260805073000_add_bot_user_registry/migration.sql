CREATE TABLE IF NOT EXISTS "BotUserRegistry" (
    "id" TEXT NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "username" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "phone" TEXT,
    "phoneVerified" BOOLEAN NOT NULL DEFAULT false,
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotUserRegistry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "BotUserRegistry_telegramId_key"
    ON "BotUserRegistry"("telegramId");

CREATE INDEX IF NOT EXISTS "BotUserRegistry_lastSeenAt_idx"
    ON "BotUserRegistry"("lastSeenAt" DESC);

-- Backfill accounts that opened the bot before this registry existed.
-- The survey user table is the broadest historical source. DISTINCT ON keeps
-- one row when the same Telegram account interacted with more than one bot.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "username",
    "firstName",
    "firstSeenAt",
    "lastSeenAt"
)
SELECT
    'legacy_user_' || historical_user."telegram_id"::TEXT,
    historical_user."telegram_id",
    historical_user."username",
    historical_user."first_name",
    historical_user."created_at",
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("telegram_id")
        "telegram_id",
        "username",
        "first_name",
        "created_at"
    FROM "users"
    ORDER BY "telegram_id", "created_at" ASC
) AS historical_user
ON CONFLICT ("telegramId") DO NOTHING;

-- Keep existing manual/automatic driver links visible even if no survey user
-- record was created for that Telegram account.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "username",
    "phoneVerified",
    "firstSeenAt",
    "lastSeenAt"
)
SELECT
    'legacy_link_' || "id",
    "telegramId",
    "username",
    "phoneVerified",
    "createdAt",
    CURRENT_TIMESTAMP
FROM "DriverTelegram"
ON CONFLICT ("telegramId") DO NOTHING;

-- Older manual-link requests are another valid proof that the account used
-- the bot. Preserve one earliest request for each Telegram account.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "firstSeenAt",
    "lastSeenAt"
)
SELECT
    'legacy_request_' || historical_request."telegramId"::TEXT,
    historical_request."telegramId",
    historical_request."createdAt",
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("telegramId")
        "telegramId",
        "createdAt"
    FROM "BotChatMessage"
    ORDER BY "telegramId", "createdAt" ASC
) AS historical_request
ON CONFLICT ("telegramId") DO NOTHING;

-- Telegram chats are a historical proof that the account interacted with the
-- bot even when no survey row or driver link was created.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "firstSeenAt",
    "lastSeenAt"
)
SELECT
    'legacy_chat_' || regexp_replace("externalChatId", '^telegram:', ''),
    regexp_replace("externalChatId", '^telegram:', '')::BIGINT,
    "createdAt",
    COALESCE("lastMessageAt", "updatedAt", "createdAt")
FROM "Chat"
WHERE "channel" = 'telegram'
  AND "externalChatId" ~ '^(telegram:)?[0-9]+$'
ON CONFLICT ("telegramId") DO NOTHING;

-- Recovery for the concrete account whose NOT_LINKED incident exposed the
-- missing-registry gap. The alert itself proves that this account used the bot.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "firstSeenAt",
    "lastSeenAt"
)
VALUES (
    'incident_1009966916',
    1009966916,
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
)
ON CONFLICT ("telegramId") DO NOTHING;
