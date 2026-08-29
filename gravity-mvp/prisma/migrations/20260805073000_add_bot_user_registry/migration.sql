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

-- A recorded manual-link request is direct evidence that the account used the
-- driver bot. Preserve the earliest request for each Telegram account.
INSERT INTO "BotUserRegistry" ("id", "telegramId", "firstSeenAt", "lastSeenAt")
SELECT
    'legacy_request_' || historical_request."telegramId"::TEXT,
    historical_request."telegramId",
    historical_request."createdAt",
    CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON ("telegramId") "telegramId", "createdAt"
    FROM "BotChatMessage"
    ORDER BY "telegramId", "createdAt" ASC
) AS historical_request
ON CONFLICT ("telegramId") DO NOTHING;

INSERT INTO "BotUserRegistry" (
    "id", "telegramId", "username", "phoneVerified", "firstSeenAt", "lastSeenAt"
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

-- The original NOT_LINKED incident is itself direct driver-bot evidence.
INSERT INTO "BotUserRegistry" ("id", "telegramId", "firstSeenAt", "lastSeenAt")
VALUES ('incident_1009966916', 1009966916, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("telegramId") DO NOTHING;
