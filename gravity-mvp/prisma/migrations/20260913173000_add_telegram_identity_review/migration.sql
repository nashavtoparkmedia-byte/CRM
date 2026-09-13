-- A durable trace for every Telegram identity decision that refused to act.
-- Fail-closed is only safe if somebody can see what failed and why; without
-- this table an unidentifiable driver just vanishes from the funnel.

CREATE TABLE IF NOT EXISTS "TelegramIdentityReview" (
  "id"                  TEXT NOT NULL,
  "telegramUserId"      TEXT NOT NULL,
  "normalizedPhone"     TEXT,
  "reason"              TEXT NOT NULL,
  "identityContactId"   TEXT,
  "candidateContactIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "observedAt"          TIMESTAMP(3) NOT NULL,
  "resolvedAt"          TIMESTAMP(3),
  "resolvedBy"          TEXT,
  "createdAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "TelegramIdentityReview_pkey" PRIMARY KEY ("id")
);

-- Replaying one share must not stack identical rows for a manager to read.
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramIdentityReview_account_reason_key"
  ON "TelegramIdentityReview" ("telegramUserId", "reason", "observedAt");

CREATE INDEX IF NOT EXISTS "TelegramIdentityReview_resolvedAt_idx"
  ON "TelegramIdentityReview" ("resolvedAt");

CREATE INDEX IF NOT EXISTS "TelegramIdentityReview_telegramUserId_idx"
  ON "TelegramIdentityReview" ("telegramUserId");

-- A resolution needs both its timestamp and its author, or neither.
ALTER TABLE "TelegramIdentityReview"
  ADD CONSTRAINT "TelegramIdentityReview_resolution_complete"
  CHECK (("resolvedAt" IS NULL) = ("resolvedBy" IS NULL));

-- The attestation columns belong to the same owner as this table, and a
-- column-only migration cannot be declared in the pending manifest, so
-- they travel together rather than as an undeclarable fragment.
ALTER TABLE "DriverTelegram" ADD COLUMN IF NOT EXISTS "attestedPhone" TEXT;
ALTER TABLE "DriverTelegram" ADD COLUMN IF NOT EXISTS "attestedPhoneAt" TIMESTAMP(3);

-- A stored attestation must carry its timestamp, and a timestamp must carry a
-- phone. Half a proof is not a proof.
ALTER TABLE "DriverTelegram"
  ADD CONSTRAINT "DriverTelegram_attested_phone_complete"
  CHECK (("attestedPhone" IS NULL) = ("attestedPhoneAt" IS NULL));
