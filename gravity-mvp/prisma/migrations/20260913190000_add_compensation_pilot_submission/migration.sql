-- What the Telegram pilot collects around a C1 application.
--
-- Deliberately a separate table. CompensationApplication is the monetary
-- record C1 froze, and adding pilot workflow columns to it would make the
-- money table depend on how one channel happens to ask its questions.

-- Wrapped in one explicit transaction. The canonical replay proves a pending
-- migration rolls back cleanly, and it can only do that if the migration
-- declares its own transaction boundary rather than relying on the tool's.
BEGIN;

CREATE TABLE IF NOT EXISTS "CompensationPilotSubmission" (
  "id"                 TEXT NOT NULL,
  "applicationId"      TEXT NOT NULL,
  "telegramUserId"     TEXT NOT NULL,
  "supportContactedAt" TIMESTAMPTZ(3) NOT NULL,
  "attachmentFileId"   TEXT NOT NULL,
  "attachmentKind"     VARCHAR(16) NOT NULL,
  "claimedRubles"      INTEGER NOT NULL,
  "createdAt"          TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompensationPilotSubmission_pkey" PRIMARY KEY ("id"),
  -- The pilot cap is 1000 rubles. C1 caps what it will ever pay at the same
  -- figure, but accepts larger claims, so the pilot rule is enforced here too
  -- rather than being silently absorbed by the payable cap.
  CONSTRAINT "CompensationPilotSubmission_claim_within_pilot_cap"
    CHECK ("claimedRubles" >= 1 AND "claimedRubles" <= 1000),
  CONSTRAINT "CompensationPilotSubmission_attachment_present"
    CHECK (length("attachmentFileId") > 0)
);

-- One pilot row per application: a resubmit must not stack evidence rows.
CREATE UNIQUE INDEX IF NOT EXISTS "CompensationPilotSubmission_application_key"
  ON "CompensationPilotSubmission" ("applicationId");

CREATE INDEX IF NOT EXISTS "CompensationPilotSubmission_telegramUserId_idx"
  ON "CompensationPilotSubmission" ("telegramUserId");

COMMIT;
