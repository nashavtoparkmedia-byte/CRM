-- Runtime ingestion state for the compensation cash-order catalogue.
-- Expand-only and additive: two nullable columns on the catalogue and one new
-- progress table. No existing row is rewritten and nothing is backfilled.

-- Wrapped in one explicit transaction. The canonical replay proves a pending
-- migration rolls back cleanly, and it can only do that if the migration
-- declares its own transaction boundary rather than relying on the tool's.
BEGIN;

-- The connection the latest accepted observation came through. Provenance
-- only, deliberately without a foreign key: rotating or deleting a credential
-- must never rewrite or block the catalogue.
ALTER TABLE "CompensationCashOrder" ADD COLUMN IF NOT EXISTS "sourceConnectionId" TEXT;

-- Yandex booked_at of the latest accepted observation that carried one. The
-- provider filters orders by booked_at, so this lets a targeted confirmation
-- ask for one order precisely. It is not part of the order identity and
-- decides neither eligibility nor money.
ALTER TABLE "CompensationCashOrder" ADD COLUMN IF NOT EXISTS "providerBookedAt" TIMESTAMPTZ(3);

-- One row per provider park. The lease fences every ingestion write, and
-- freshness and reconciliation progress only move inside the page transaction
-- that durably handled the data they describe.
CREATE TABLE IF NOT EXISTS "CompensationCashOrderIngestionCheckpoint" (
  "id"                            TEXT NOT NULL,
  "provider"                      VARCHAR(32) NOT NULL,
  "externalParkId"                VARCHAR(64) NOT NULL,
  "leaseToken"                    VARCHAR(64),
  "leaseExpiresAt"                TIMESTAMPTZ(3),
  "lastRunMode"                   VARCHAR(16),
  "lastRunStatus"                 VARCHAR(16),
  "lastRunStartedAt"              TIMESTAMPTZ(3),
  "lastRunFinishedAt"             TIMESTAMPTZ(3),
  "consecutiveFailures"           INTEGER NOT NULL DEFAULT 0,
  "lastErrorCode"                 VARCHAR(64),
  "lastErrorSummary"              VARCHAR(500),
  "lastApiConnectionId"           TEXT,
  "lastRunSummary"                JSONB,
  "lastHotSuccessAt"              TIMESTAMPTZ(3),
  "reconciliationPassStartedAt"   TIMESTAMPTZ(3),
  "reconciliationFloorBookedAt"   TIMESTAMPTZ(3),
  "reconciliationCursorBookedAt"  TIMESTAMPTZ(3),
  "lastReconciliationCompletedAt" TIMESTAMPTZ(3),
  "providerRetryNotBefore"        TIMESTAMPTZ(3),
  "providerRetryConnectionId"     TEXT,
  "createdAt"                     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"                     TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CompensationCashOrderIngestionCheckpoint_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CompensationCashOrderIngestionCheckpoint_run_mode_check"
    CHECK ("lastRunMode" IS NULL OR "lastRunMode" IN ('dry_run', 'write')),
  CONSTRAINT "CompensationCashOrderIngestionCheckpoint_run_status_check"
    CHECK ("lastRunStatus" IS NULL OR "lastRunStatus" IN ('running', 'succeeded', 'failed')),
  CONSTRAINT "CompensationCashOrderIngestionCheckpoint_failures_check"
    CHECK ("consecutiveFailures" >= 0),
  -- A lease is a token and an expiry together, never one without the other.
  CONSTRAINT "CompensationCashOrderIngestionCheckpoint_lease_check"
    CHECK (("leaseToken" IS NULL) = ("leaseExpiresAt" IS NULL))
);

-- One progress row per provider park.
CREATE UNIQUE INDEX IF NOT EXISTS "CompensationCashOrderIngestionCheckpoint_park_key"
  ON "CompensationCashOrderIngestionCheckpoint" ("provider", "externalParkId");

COMMIT;
