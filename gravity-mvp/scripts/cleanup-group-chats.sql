-- ============================================================
-- TIER 4: Cleanup legacy group-as-contact records
-- Run AFTER backup. Execute in a transaction.
-- ============================================================

-- STEP 1: Diagnostics — run these first to understand scope

-- TG groups (negative IDs)
SELECT id, "externalChatId", name, "contactId" FROM "Chat"
WHERE channel = 'telegram' AND "externalChatId" ~ '^telegram:-';

-- WA groups (@g.us)
SELECT id, "externalChatId", name, "contactId" FROM "Chat"
WHERE channel = 'whatsapp' AND "externalChatId" LIKE '%@g.us';

-- Orphan ContactIdentity (TG groups)
SELECT ci.id, ci."externalId", co."displayName"
FROM "ContactIdentity" ci JOIN "Contact" co ON co.id = ci."contactId"
WHERE ci.channel = 'telegram' AND ci."externalId" ~ '^-';


-- STEP 2: Cleanup (run in transaction after reviewing diagnostics)

BEGIN;

-- Mark legacy groups that migration may have missed
UPDATE "Chat" SET "chatType" = 'group'
WHERE channel = 'telegram' AND "externalChatId" ~ '^telegram:-' AND "chatType" = 'private';

UPDATE "Chat" SET "chatType" = 'group'
WHERE channel = 'whatsapp' AND "externalChatId" LIKE '%@g.us' AND "chatType" = 'private';

-- Unlink Contact/Driver from group chats
UPDATE "Chat"
SET "contactId" = NULL, "contactIdentityId" = NULL, "driverId" = NULL
WHERE "chatType" IN ('group', 'supergroup', 'channel');

-- Delete orphan ContactIdentity records from TG groups
-- Only deletes identities that:
-- 1. Belong to telegram channel with negative externalId (group)
-- 2. Are not linked to any Chat via contactIdentityId
-- 3. Their Contact is not used by any private chat
DELETE FROM "ContactIdentity" ci
WHERE ci.channel = 'telegram'
  AND ci."externalId" ~ '^-'
  AND ci.id NOT IN (
      SELECT "contactIdentityId" FROM "Chat" WHERE "contactIdentityId" IS NOT NULL
  )
  AND ci."contactId" NOT IN (
      SELECT DISTINCT "contactId" FROM "Chat"
      WHERE "contactId" IS NOT NULL AND "chatType" = 'private'
  );

-- Contact is NOT deleted automatically.
-- To clean up fully orphaned contacts, run a separate manual query after review.

COMMIT;
