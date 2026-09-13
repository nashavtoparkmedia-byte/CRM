-- The ingested catalogue of completed Yandex cash orders a driver can claim
-- against. Expand-only and additive: it introduces no dependency on existing
-- tables and rewrites nothing.
--
-- Deliberately separate from CompensationVerifiedOrder. That table is the
-- evidence the monetary core captures at submission time, one row per attempt.
-- This one is ingestion state, one row per real trip, and the two must not be
-- collapsed: a re-ingested page must not disturb a recorded claim.

CREATE TABLE IF NOT EXISTS "CompensationCashOrder" (
  "id"                      TEXT NOT NULL,
  "provider"                VARCHAR(32) NOT NULL,
  "externalParkId"          VARCHAR(64) NOT NULL,
  "externalOrderId"         VARCHAR(64) NOT NULL,
  "shortOrderIdDisplay"     VARCHAR(32),
  "externalDriverProfileId" VARCHAR(64) NOT NULL,
  "rawPrice"                VARCHAR(32) NOT NULL,
  "amountKopecks"           INTEGER NOT NULL,
  "endedAt"                 TIMESTAMPTZ(3) NOT NULL,
  "observedAt"              TIMESTAMPTZ(3) NOT NULL,
  "createdAt"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"               TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompensationCashOrder_pkey" PRIMARY KEY ("id"),
  -- A cash order is money-adjacent, so the invariants live in the database
  -- rather than only in the code that writes it.
  CONSTRAINT "CompensationCashOrder_amount_nonnegative" CHECK ("amountKopecks" >= 0),
  CONSTRAINT "CompensationCashOrder_price_four_decimals"
    CHECK ("rawPrice" ~ '^(0|[1-9][0-9]{0,6})\.[0-9]{4}$')
);

-- Ingestion idempotency: the same provider order in the same park is one row,
-- however many times a page is replayed.
CREATE UNIQUE INDEX IF NOT EXISTS "CompensationCashOrder_provider_identity_key"
  ON "CompensationCashOrder" ("provider", "externalParkId", "externalOrderId");

-- Serves the driver-facing list: this park, this profile, this month.
CREATE INDEX IF NOT EXISTS "CompensationCashOrder_driver_month_idx"
  ON "CompensationCashOrder" ("externalParkId", "externalDriverProfileId", "endedAt");

-- Driver eligibility facts travel with this migration because Driver and
-- CompensationCashOrder share one owner, and a migration that only added
-- columns could not be declared: the pending-migration manifest requires
-- every entry to create an object its rollback proof can check.
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
