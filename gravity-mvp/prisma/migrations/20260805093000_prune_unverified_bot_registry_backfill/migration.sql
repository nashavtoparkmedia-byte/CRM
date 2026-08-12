-- Retained for production migration-lineage compatibility. The accepted
-- creation migration never inserts these unproven broad-source rows.
DELETE FROM "BotUserRegistry"
WHERE "id" LIKE 'legacy_chat_%'
   OR "id" LIKE 'legacy_user_%';
