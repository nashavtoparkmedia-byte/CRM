ALTER TABLE "DriverTelegram"
    ADD COLUMN "submittedPhone" TEXT,
    ADD COLUMN "submittedPhoneAt" TIMESTAMP(3);

-- This phone was captured in the production sync_user audit before the
-- dedicated columns existed. Preserve it as part of the data repair that
-- introduced the fields; other historical rows remain unknown.
UPDATE "DriverTelegram"
SET "submittedPhone" = '79225205555',
    "submittedPhoneAt" = "createdAt"
WHERE "telegramId" = 449647107;
