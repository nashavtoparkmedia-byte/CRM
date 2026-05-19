-- Add isTemporary + expiresAt columns to ContactPhone for Avito's
-- temporary-number workflow (see schema.prisma comment).
--
-- Same history as 20260520210000_add_cancelled_callstatus: the columns
-- were added ad-hoc on telephony-deploy and the migration file never
-- landed in main. IF NOT EXISTS keeps this idempotent: on the dev DB
-- (where the columns already exist) the ALTERs are no-ops, on a
-- greenfield DB they get created.
ALTER TABLE "ContactPhone" ADD COLUMN IF NOT EXISTS "isTemporary" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ContactPhone" ADD COLUMN IF NOT EXISTS "expiresAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "ContactPhone_isTemporary_expiresAt_idx" ON "ContactPhone"("isTemporary", "expiresAt");
