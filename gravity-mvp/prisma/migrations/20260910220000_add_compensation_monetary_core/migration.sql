-- Fleet Operations-owned YOKO cash compensation monetary core.
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery goal; production deployment remains a separate reviewed
-- operation. It adds ten new tables and touches no existing table.
--
-- Money is stored as integer kopecks throughout. Business days and budget
-- months are Asia/Yekaterinburg calendar units and are stored as explicit
-- keys, never re-derived from a timestamp at read time.

BEGIN;

-- CreateTable
CREATE TABLE "CompensationBudgetPeriod" (
    "id" TEXT NOT NULL,
    "periodKey" VARCHAR(7) NOT NULL,
    "periodStartsAt" TIMESTAMPTZ(3) NOT NULL,
    "periodEndsAt" TIMESTAMPTZ(3) NOT NULL,
    "submissionClosesAt" TIMESTAMPTZ(3) NOT NULL,
    "limitKopecks" INTEGER NOT NULL,
    "reservedKopecks" INTEGER NOT NULL DEFAULT 0,
    "settledKopecks" INTEGER NOT NULL DEFAULT 0,
    "state" VARCHAR(16) NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationBudgetPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationPerson" (
    "id" TEXT NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'active',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationPerson_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationPersonBinding" (
    "id" TEXT NOT NULL,
    "compensationPersonId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "lineageDigest" VARCHAR(128) NOT NULL,
    "boundVia" VARCHAR(64) NOT NULL,
    "boundAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "CompensationPersonBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationVerifiedOrder" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "externalParkId" VARCHAR(64) NOT NULL,
    "externalOrderId" VARCHAR(64) NOT NULL,
    "shortOrderIdDisplay" VARCHAR(32),
    "rawPrice" VARCHAR(32) NOT NULL,
    "amountKopecks" INTEGER NOT NULL,
    "endedAt" TIMESTAMPTZ(3) NOT NULL,
    "verifiedAt" TIMESTAMPTZ(3) NOT NULL,
    "payloadDigest" CHAR(64) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationVerifiedOrder_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationOrderClaim" (
    "id" TEXT NOT NULL,
    "provider" VARCHAR(32) NOT NULL,
    "externalParkId" VARCHAR(64) NOT NULL,
    "externalOrderId" VARCHAR(64) NOT NULL,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "settledApplicationId" TEXT,
    "submissionDeadline" TIMESTAMPTZ(3) NOT NULL,
    "deadlineBasis" VARCHAR(32) NOT NULL,
    "budgetPeriodKey" VARCHAR(7) NOT NULL,
    "orderEndedAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationOrderClaim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationApplication" (
    "id" TEXT NOT NULL,
    "idempotencyKey" VARCHAR(64) NOT NULL,
    "payloadFingerprint" CHAR(64) NOT NULL,
    "compensationPersonId" TEXT NOT NULL,
    "orderClaimId" TEXT NOT NULL,
    "verifiedOrderId" TEXT NOT NULL,
    "budgetPeriodId" TEXT NOT NULL,
    "attemptNo" INTEGER NOT NULL,
    "claimedKopecks" INTEGER NOT NULL,
    "amountKopecks" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "version" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMPTZ(3) NOT NULL,
    "paidAt" TIMESTAMPTZ(3),
    "rejectedAt" TIMESTAMPTZ(3),
    "rejectionKey" VARCHAR(64),
    "rejectionReason" VARCHAR(500),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationApplication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationPayoutAuthorization" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "compensationPersonId" TEXT NOT NULL,
    "intendedBusinessDay" VARCHAR(10) NOT NULL,
    "amountKopecks" INTEGER NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'active',
    "authorizationFence" CHAR(64) NOT NULL,
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "closedAt" TIMESTAMPTZ(3),
    "closureReason" VARCHAR(200),
    "settlementId" VARCHAR(255),
    "openedByPrincipal" VARCHAR(255) NOT NULL,
    "openedByLabel" VARCHAR(255),
    "closedByPrincipal" VARCHAR(255),
    "closedByLabel" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationPayoutAuthorization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationSettlement" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "payoutAuthorizationId" TEXT NOT NULL,
    "orderClaimId" TEXT NOT NULL,
    "budgetPeriodId" TEXT NOT NULL,
    "compensationPersonId" TEXT NOT NULL,
    "amountKopecks" INTEGER NOT NULL,
    "businessDay" VARCHAR(10) NOT NULL,
    "settledAt" TIMESTAMPTZ(3) NOT NULL,
    "settledByPrincipal" VARCHAR(255) NOT NULL,
    "settledByLabel" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationSettlement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationReconciliationTask" (
    "id" TEXT NOT NULL,
    "payoutAuthorizationId" TEXT NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'open',
    "openedAt" TIMESTAMPTZ(3) NOT NULL,
    "resolvedAt" TIMESTAMPTZ(3),
    "resolution" VARCHAR(32),
    "resolutionEvidence" VARCHAR(1000),
    "openedByPrincipal" VARCHAR(255) NOT NULL,
    "resolvedByPrincipal" VARCHAR(255),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationReconciliationTask_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationAuditEvent" (
    "id" TEXT NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "subjectType" VARCHAR(64) NOT NULL,
    "subjectId" VARCHAR(255) NOT NULL,
    "compensationPersonId" VARCHAR(255),
    "principalId" VARCHAR(255) NOT NULL,
    "principalKind" VARCHAR(32) NOT NULL,
    "operatorLabel" VARCHAR(255),
    "previousState" VARCHAR(32),
    "nextState" VARCHAR(32),
    "amountKopecks" INTEGER,
    "reason" VARCHAR(1000),
    "payoutAuthorizationId" VARCHAR(255),
    "correlationId" VARCHAR(255) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CompensationBudgetPeriod_period_key" ON "CompensationBudgetPeriod"("periodKey");

-- CreateIndex
CREATE INDEX "CompensationBudgetPeriod_state_closes_idx" ON "CompensationBudgetPeriod"("state", "submissionClosesAt");

-- CreateIndex
CREATE INDEX "CompensationPerson_state_idx" ON "CompensationPerson"("state");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationPersonBinding_contact_key" ON "CompensationPersonBinding"("contactId");

-- CreateIndex
CREATE INDEX "CompensationPersonBinding_person_idx" ON "CompensationPersonBinding"("compensationPersonId");

-- CreateIndex
CREATE INDEX "CompensationVerifiedOrder_order_verified_idx" ON "CompensationVerifiedOrder"("provider", "externalParkId", "externalOrderId", "verifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationOrderClaim_settled_key" ON "CompensationOrderClaim"("settledApplicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationOrderClaim_order_key" ON "CompensationOrderClaim"("provider", "externalParkId", "externalOrderId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationApplication_idempotency_key" ON "CompensationApplication"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CompensationApplication_person_status_idx" ON "CompensationApplication"("compensationPersonId", "status");

-- CreateIndex
CREATE INDEX "CompensationApplication_period_status_idx" ON "CompensationApplication"("budgetPeriodId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationApplication_claim_attempt_key" ON "CompensationApplication"("orderClaimId", "attemptNo");

-- CreateIndex
CREATE INDEX "CompensationPayoutAuthorization_application_state_idx" ON "CompensationPayoutAuthorization"("applicationId", "state");

-- CreateIndex
CREATE INDEX "CompensationPayoutAuthorization_person_day_idx" ON "CompensationPayoutAuthorization"("compensationPersonId", "intendedBusinessDay", "state");

-- CreateIndex
CREATE INDEX "CompensationPayoutAuthorization_state_expires_idx" ON "CompensationPayoutAuthorization"("state", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationSettlement_application_key" ON "CompensationSettlement"("applicationId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationSettlement_authorization_key" ON "CompensationSettlement"("payoutAuthorizationId");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationSettlement_claim_key" ON "CompensationSettlement"("orderClaimId");

-- CreateIndex
CREATE INDEX "CompensationSettlement_period_settled_idx" ON "CompensationSettlement"("budgetPeriodId", "settledAt");

-- CreateIndex
CREATE INDEX "CompensationSettlement_person_day_idx" ON "CompensationSettlement"("compensationPersonId", "businessDay");

-- CreateIndex
CREATE INDEX "CompensationReconciliationTask_state_opened_idx" ON "CompensationReconciliationTask"("state", "openedAt");

-- CreateIndex
CREATE INDEX "CompensationReconciliationTask_authorization_idx" ON "CompensationReconciliationTask"("payoutAuthorizationId");

-- CreateIndex
CREATE INDEX "CompensationAuditEvent_subject_idx" ON "CompensationAuditEvent"("subjectType", "subjectId", "occurredAt", "id");

-- CreateIndex
CREATE INDEX "CompensationAuditEvent_action_idx" ON "CompensationAuditEvent"("action", "occurredAt");

-- AddForeignKey
ALTER TABLE "CompensationPersonBinding" ADD CONSTRAINT "CompensationPersonBinding_person_fkey" FOREIGN KEY ("compensationPersonId") REFERENCES "CompensationPerson"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationApplication" ADD CONSTRAINT "CompensationApplication_person_fkey" FOREIGN KEY ("compensationPersonId") REFERENCES "CompensationPerson"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationApplication" ADD CONSTRAINT "CompensationApplication_claim_fkey" FOREIGN KEY ("orderClaimId") REFERENCES "CompensationOrderClaim"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationApplication" ADD CONSTRAINT "CompensationApplication_verified_order_fkey" FOREIGN KEY ("verifiedOrderId") REFERENCES "CompensationVerifiedOrder"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationApplication" ADD CONSTRAINT "CompensationApplication_period_fkey" FOREIGN KEY ("budgetPeriodId") REFERENCES "CompensationBudgetPeriod"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationPayoutAuthorization" ADD CONSTRAINT "CompensationPayoutAuthorization_application_fkey" FOREIGN KEY ("applicationId") REFERENCES "CompensationApplication"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationPayoutAuthorization" ADD CONSTRAINT "CompensationPayoutAuthorization_person_fkey" FOREIGN KEY ("compensationPersonId") REFERENCES "CompensationPerson"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationSettlement" ADD CONSTRAINT "CompensationSettlement_application_fkey" FOREIGN KEY ("applicationId") REFERENCES "CompensationApplication"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationSettlement" ADD CONSTRAINT "CompensationSettlement_authorization_fkey" FOREIGN KEY ("payoutAuthorizationId") REFERENCES "CompensationPayoutAuthorization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationSettlement" ADD CONSTRAINT "CompensationSettlement_claim_fkey" FOREIGN KEY ("orderClaimId") REFERENCES "CompensationOrderClaim"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationSettlement" ADD CONSTRAINT "CompensationSettlement_period_fkey" FOREIGN KEY ("budgetPeriodId") REFERENCES "CompensationBudgetPeriod"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationSettlement" ADD CONSTRAINT "CompensationSettlement_person_fkey" FOREIGN KEY ("compensationPersonId") REFERENCES "CompensationPerson"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "CompensationReconciliationTask" ADD CONSTRAINT "CompensationReconciliationTask_authorization_fkey" FOREIGN KEY ("payoutAuthorizationId") REFERENCES "CompensationPayoutAuthorization"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- Monetary invariants that Prisma cannot express.
--
-- The four partial unique indexes at the end of this file carry most of the
-- correctness of the compensation core. They are not an optimisation.
-- ---------------------------------------------------------------------------

ALTER TABLE "CompensationBudgetPeriod"
  ADD CONSTRAINT "CompensationBudgetPeriod_state_check"
    CHECK ("state" IN ('open', 'closed')),
  ADD CONSTRAINT "CompensationBudgetPeriod_periodKey_check"
    CHECK ("periodKey" ~ '^[0-9]{4}-[0-9]{2}$'),
  ADD CONSTRAINT "CompensationBudgetPeriod_limit_check"
    CHECK ("limitKopecks" > 0),
  ADD CONSTRAINT "CompensationBudgetPeriod_reserved_check"
    CHECK ("reservedKopecks" >= 0),
  ADD CONSTRAINT "CompensationBudgetPeriod_settled_check"
    CHECK ("settledKopecks" >= 0),
  -- The pool cannot be overspent even if application code is wrong.
  ADD CONSTRAINT "CompensationBudgetPeriod_capacity_check"
    CHECK ("reservedKopecks" + "settledKopecks" <= "limitKopecks"),
  -- A period must stay open long enough for its own last-day grace window.
  ADD CONSTRAINT "CompensationBudgetPeriod_window_check"
    CHECK ("periodEndsAt" > "periodStartsAt" AND "submissionClosesAt" >= "periodEndsAt");

ALTER TABLE "CompensationPerson"
  ADD CONSTRAINT "CompensationPerson_state_check"
    CHECK ("state" IN ('active', 'reconciliation_required'));

ALTER TABLE "CompensationVerifiedOrder"
  ADD CONSTRAINT "CompensationVerifiedOrder_amount_check"
    CHECK ("amountKopecks" >= 0),
  ADD CONSTRAINT "CompensationVerifiedOrder_rawPrice_check"
    CHECK ("rawPrice" ~ '^(0|[1-9][0-9]{0,7})\.[0-9]{4}$');

ALTER TABLE "CompensationOrderClaim"
  ADD CONSTRAINT "CompensationOrderClaim_attemptCount_check"
    CHECK ("attemptCount" >= 0 AND "attemptCount" <= 2),
  ADD CONSTRAINT "CompensationOrderClaim_deadlineBasis_check"
    CHECK ("deadlineBasis" IN ('order_month_end', 'last_day_grace')),
  ADD CONSTRAINT "CompensationOrderClaim_budgetPeriodKey_check"
    CHECK ("budgetPeriodKey" ~ '^[0-9]{4}-[0-9]{2}$'),
  ADD CONSTRAINT "CompensationOrderClaim_settled_attempt_check"
    CHECK ("settledApplicationId" IS NULL OR "attemptCount" >= 1);

ALTER TABLE "CompensationApplication"
  ADD CONSTRAINT "CompensationApplication_status_check"
    CHECK ("status" IN ('PENDING', 'PAID', 'REJECTED')),
  ADD CONSTRAINT "CompensationApplication_attemptNo_check"
    CHECK ("attemptNo" IN (1, 2)),
  ADD CONSTRAINT "CompensationApplication_version_check"
    CHECK ("version" >= 0),
  ADD CONSTRAINT "CompensationApplication_claimed_check"
    CHECK ("claimedKopecks" > 0),
  -- 1000 RUB product cap, enforced by the database and not only by code.
  ADD CONSTRAINT "CompensationApplication_amount_check"
    CHECK ("amountKopecks" > 0 AND "amountKopecks" <= 100000),
  ADD CONSTRAINT "CompensationApplication_amount_le_claimed_check"
    CHECK ("amountKopecks" <= "claimedKopecks"),
  ADD CONSTRAINT "CompensationApplication_paid_check"
    CHECK (("status" = 'PAID') = ("paidAt" IS NOT NULL)),
  ADD CONSTRAINT "CompensationApplication_rejection_check"
    CHECK (
      ("status" <> 'REJECTED')
      OR ("rejectedAt" IS NOT NULL AND "rejectionKey" IS NOT NULL AND "rejectionReason" IS NOT NULL)
    );

ALTER TABLE "CompensationPayoutAuthorization"
  ADD CONSTRAINT "CompensationPayoutAuthorization_state_check"
    CHECK ("state" IN ('active', 'unknown_outcome', 'finalized', 'cancelled')),
  ADD CONSTRAINT "CompensationPayoutAuthorization_amount_check"
    CHECK ("amountKopecks" > 0),
  ADD CONSTRAINT "CompensationPayoutAuthorization_businessDay_check"
    CHECK ("intendedBusinessDay" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'),
  ADD CONSTRAINT "CompensationPayoutAuthorization_expiry_check"
    CHECK ("expiresAt" > "openedAt"),
  ADD CONSTRAINT "CompensationPayoutAuthorization_settlement_check"
    CHECK (("state" = 'finalized') = ("settlementId" IS NOT NULL)),
  -- active and unknown_outcome are the two states that still hold locks, and
  -- neither is closed.
  ADD CONSTRAINT "CompensationPayoutAuthorization_closed_check"
    CHECK (("state" IN ('active', 'unknown_outcome')) = ("closedAt" IS NULL));

ALTER TABLE "CompensationSettlement"
  ADD CONSTRAINT "CompensationSettlement_amount_check"
    CHECK ("amountKopecks" > 0),
  ADD CONSTRAINT "CompensationSettlement_businessDay_check"
    CHECK ("businessDay" ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$');

ALTER TABLE "CompensationReconciliationTask"
  ADD CONSTRAINT "CompensationReconciliationTask_state_check"
    CHECK ("state" IN ('open', 'resolved')),
  ADD CONSTRAINT "CompensationReconciliationTask_resolution_value_check"
    CHECK ("resolution" IS NULL OR "resolution" IN ('paid', 'not_paid')),
  ADD CONSTRAINT "CompensationReconciliationTask_resolved_check"
    CHECK (
      ("state" = 'resolved')
      = ("resolution" IS NOT NULL AND "resolvedAt" IS NOT NULL AND "resolvedByPrincipal" IS NOT NULL)
    );

ALTER TABLE "CompensationAuditEvent"
  ADD CONSTRAINT "CompensationAuditEvent_principalKind_check"
    CHECK ("principalKind" IN ('crm_user', 'integration_admin', 'system')),
  ADD CONSTRAINT "CompensationAuditEvent_action_check"
    CHECK ("action" IN (
      'submit',
      'reject',
      'payout_authorization_opened',
      'payout_authorization_cancelled',
      'payout_authorization_unknown',
      'payout_finalized',
      'reconciliation_resolved',
      'period_opened',
      'period_closed'
    ));

-- ---------------------------------------------------------------------------
-- Partial unique indexes: the monetary rules themselves.
-- ---------------------------------------------------------------------------

-- One active PENDING per canonical person, across every YOKO profile.
CREATE UNIQUE INDEX "CompensationApplication_person_active_pending_key"
  ON "CompensationApplication" ("compensationPersonId")
  WHERE "status" = 'PENDING';

-- One unresolved payout authorization per application.
CREATE UNIQUE INDEX "CompensationPayoutAuthorization_application_open_key"
  ON "CompensationPayoutAuthorization" ("applicationId")
  WHERE "state" IN ('active', 'unknown_outcome');

-- Exclusive payout right: one unresolved authorization per person at a time.
CREATE UNIQUE INDEX "CompensationPayoutAuthorization_person_open_key"
  ON "CompensationPayoutAuthorization" ("compensationPersonId")
  WHERE "state" IN ('active', 'unknown_outcome');

-- At most one actual payout per person per business day. The slot is claimed
-- when preparation starts, which is what stops finalize from discovering a new
-- daily conflict after money has already left the external dispatcher.
CREATE UNIQUE INDEX "CompensationPayoutAuthorization_person_day_key"
  ON "CompensationPayoutAuthorization" ("compensationPersonId", "intendedBusinessDay")
  WHERE "state" IN ('active', 'unknown_outcome', 'finalized');

-- One open reconciliation task per authorization.
CREATE UNIQUE INDEX "CompensationReconciliationTask_open_key"
  ON "CompensationReconciliationTask" ("payoutAuthorizationId")
  WHERE "state" = 'open';

COMMIT;
