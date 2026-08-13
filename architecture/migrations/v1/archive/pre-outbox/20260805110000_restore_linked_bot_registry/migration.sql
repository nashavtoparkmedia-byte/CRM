-- A linked Telegram account is authoritative driver-bot evidence even when an
-- older broad-source registry row was removed during historical cleanup.
INSERT INTO "BotUserRegistry" (
    "id",
    "telegramId",
    "username",
    "phoneVerified",
    "firstSeenAt",
    "lastSeenAt"
)
SELECT
    'linked_driver_' || "id",
    "telegramId",
    "username",
    "phoneVerified",
    "createdAt",
    "createdAt"
FROM "DriverTelegram"
ON CONFLICT ("telegramId") DO UPDATE SET
    "username" = COALESCE(EXCLUDED."username", "BotUserRegistry"."username"),
    "phoneVerified" = "BotUserRegistry"."phoneVerified" OR EXCLUDED."phoneVerified";
