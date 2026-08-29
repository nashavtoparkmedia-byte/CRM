-- Chat and generic survey tables are shared by several Telegram integrations.
-- Their rows do not prove that an account opened the drivers bot, so they must
-- not be shown as pending driver-link requests. Keep only registry entries
-- created by the drivers bot, proven link requests, or existing driver links.
DELETE FROM "BotUserRegistry"
WHERE "id" LIKE 'legacy_chat_%'
   OR "id" LIKE 'legacy_user_%';
