-- Cash-compensation pilot prerequisites: explicit Yandex-sourced eligibility
-- facts on Driver, and the Telegram-attested phone proof the CRM was
-- discarding. Expand-only: every column is nullable and nothing is rewritten,
-- so the migration is safe to apply ahead of the code that fills it in.

-- driver_profile.is_selfemployed is the authoritative park-SMZ flag. NULL is an
-- unknown, not a "no": eligibility fails closed on it rather than guessing.
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "isSelfEmployed" BOOLEAN;

-- driver_profile.employment_type, carried for audit. Observed live values are
-- park_employee, selfemployed and individual_entrepreneur. The entrepreneur
-- value is NOT park-SMZ, which is why the boolean above stays decisive.
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "employmentType" TEXT;

-- driver_profile.hire_date: the park connection date. Kept apart from
-- "hiredAt", which is populated from created_date and is already consumed by
-- scoring and the driver views; compensation eligibility reads only this one.
ALTER TABLE "Driver" ADD COLUMN IF NOT EXISTS "yandexHireDate" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "Driver_yandexHireDate_idx" ON "Driver" ("yandexHireDate");

-- Telegram attests a phone when the shared contact card carries the sending
-- account's own id. The bot already checks that and the CRM already receives
-- it; these columns are where the proof is finally kept.
ALTER TABLE "DriverTelegram" ADD COLUMN IF NOT EXISTS "attestedPhone" TEXT;
ALTER TABLE "DriverTelegram" ADD COLUMN IF NOT EXISTS "attestedPhoneAt" TIMESTAMP(3);

-- A stored attestation must carry its timestamp, and a timestamp must carry a
-- phone. Half a proof is not a proof.
ALTER TABLE "DriverTelegram"
  ADD CONSTRAINT "DriverTelegram_attested_phone_complete"
  CHECK (("attestedPhone" IS NULL) = ("attestedPhoneAt" IS NULL));
