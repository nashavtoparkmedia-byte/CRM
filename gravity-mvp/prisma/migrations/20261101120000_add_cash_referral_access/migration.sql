-- Fleet Operations-owned Cash Referral Access ledger and attribution.
--
-- Expand-only SOURCE migration. Production application is a separate
-- reviewed operation. It adds two new tables and touches no existing table;
-- no foreign key reaches outside them, and nothing here changes a monetary
-- table, constraint or rule.
--
-- CashAccessEvent is append-only. A trigger refuses UPDATE, DELETE and
-- TRUNCATE; it reads no relation, so no name it uses can be redirected. The
-- hash chain over the rows is checked by the application verifier, because
-- the database role can still rewrite rows directly.

BEGIN;

-- CreateTable
CREATE TABLE "CashReferralAttribution" (
    "id" TEXT NOT NULL,
    "inviterContactId" VARCHAR(255) NOT NULL,
    "inviterLineageDigest" VARCHAR(128) NOT NULL,
    "codeHash" VARCHAR(64) NOT NULL,
    "inviteeTelegramUserId" VARCHAR(64) NOT NULL,
    "inviteeDriverId" VARCHAR(255),
    "inviteeContactId" VARCHAR(255),
    "inviteePersonKey" VARCHAR(255),
    "state" VARCHAR(32) NOT NULL DEFAULT 'captured',
    "reason" VARCHAR(64),
    "targetParkId" VARCHAR(255),
    "factsSnapshot" JSONB,
    "capturedAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashReferralAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CashAccessEvent" (
    "id" TEXT NOT NULL,
    "chainContactId" VARCHAR(255) NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "lineageDigest" VARCHAR(128) NOT NULL,
    "codeHash" VARCHAR(64),
    "attributionId" VARCHAR(255),
    "payload" JSONB NOT NULL DEFAULT '{}',
    "actorKind" VARCHAR(32) NOT NULL,
    "actorId" VARCHAR(255) NOT NULL,
    "actorCapability" VARCHAR(64),
    "actorSessionId" VARCHAR(255),
    "actorAuthenticatedAt" TIMESTAMPTZ(3),
    "reason" VARCHAR(1000),
    "idempotencyKey" VARCHAR(255) NOT NULL,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL,
    "prevHash" VARCHAR(64),
    "hash" VARCHAR(64) NOT NULL,

    CONSTRAINT "CashAccessEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CashReferralAttribution_invitee_telegram_key" ON "CashReferralAttribution"("inviteeTelegramUserId");

-- CreateIndex
CREATE INDEX "CashReferralAttribution_inviter_idx" ON "CashReferralAttribution"("inviterContactId", "capturedAt");

-- CreateIndex
CREATE INDEX "CashReferralAttribution_state_idx" ON "CashReferralAttribution"("state", "capturedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccessEvent_idempotency_key" ON "CashAccessEvent"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CashAccessEvent_chain_seq_key" ON "CashAccessEvent"("chainContactId", "seq");

-- CreateIndex
CREATE INDEX "CashAccessEvent_attribution_idx" ON "CashAccessEvent"("attributionId", "seq");

-- AddForeignKey
ALTER TABLE "CashAccessEvent" ADD CONSTRAINT "CashAccessEvent_attributionId_fkey" FOREIGN KEY ("attributionId") REFERENCES "CashReferralAttribution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Value rules.
-- ---------------------------------------------------------------------------

ALTER TABLE "CashReferralAttribution"
  ADD CONSTRAINT "CashReferralAttribution_state_check"
    CHECK ("state" IN ('captured', 'pending', 'needs_review', 'not_qualified', 'qualified', 'rejected')),
  ADD CONSTRAINT "CashReferralAttribution_qualified_person_check"
    CHECK ("state" <> 'qualified' OR ("inviteePersonKey" IS NOT NULL AND "inviteeContactId" IS NOT NULL AND "decidedAt" IS NOT NULL)),
  ADD CONSTRAINT "CashReferralAttribution_code_hash_check"
    CHECK ("codeHash" ~ '^[0-9a-f]{64}$'),
  ADD CONSTRAINT "CashReferralAttribution_version_check"
    CHECK ("version" >= 0);

ALTER TABLE "CashAccessEvent"
  ADD CONSTRAINT "CashAccessEvent_kind_check"
    CHECK ("kind" IN (
      'referral_code_issued',
      'referral_captured',
      'referral_decided',
      'referral_entitlement_granted',
      'referral_entitlement_revoked',
      'referral_sanctioned',
      'manual_granted',
      'manual_denied',
      'manual_cleared',
      'invitee_dismissal_observed'
    )),
  -- The one writer each kind admits: system kinds only from the system,
  -- manager kinds only from a signed staff session that holds the capability
  -- and states a reason.
  ADD CONSTRAINT "CashAccessEvent_writer_check"
    CHECK (
      (
        "kind" IN ('referral_code_issued', 'referral_captured', 'referral_decided', 'referral_entitlement_granted', 'invitee_dismissal_observed')
        AND "actorKind" = 'system'
        AND "actorCapability" IS NULL
        AND "actorSessionId" IS NULL
      )
      OR (
        "kind" IN ('referral_entitlement_revoked', 'manual_granted', 'manual_denied', 'manual_cleared')
        AND "actorKind" = 'signed_staff_session'
        AND "actorCapability" = 'cash.access.manage'
        AND "actorSessionId" IS NOT NULL
        AND "actorAuthenticatedAt" IS NOT NULL
        AND "reason" IS NOT NULL
        AND char_length(btrim("reason")) >= 10
      )
      OR (
        "kind" = 'referral_sanctioned'
        AND "actorKind" = 'signed_staff_session'
        AND "actorCapability" = 'cash.referral.qualify'
        AND "actorSessionId" IS NOT NULL
        AND "actorAuthenticatedAt" IS NOT NULL
        AND "reason" IS NOT NULL
        AND char_length(btrim("reason")) >= 10
      )
    ),
  ADD CONSTRAINT "CashAccessEvent_actor_id_check"
    CHECK (char_length(btrim("actorId")) > 0),
  ADD CONSTRAINT "CashAccessEvent_code_hash_check"
    CHECK ((("kind" = 'referral_code_issued') = ("codeHash" IS NOT NULL)) AND ("codeHash" IS NULL OR "codeHash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "CashAccessEvent_attribution_check"
    CHECK (
      ("kind" IN ('referral_captured', 'referral_decided', 'referral_entitlement_granted', 'referral_entitlement_revoked', 'referral_sanctioned', 'invitee_dismissal_observed'))
      = ("attributionId" IS NOT NULL)
    ),
  ADD CONSTRAINT "CashAccessEvent_chain_check"
    CHECK ("seq" >= 1 AND (("seq" = 1) = ("prevHash" IS NULL))),
  ADD CONSTRAINT "CashAccessEvent_hash_check"
    CHECK ("hash" ~ '^[0-9a-f]{64}$' AND ("prevHash" IS NULL OR "prevHash" ~ '^[0-9a-f]{64}$')),
  ADD CONSTRAINT "CashAccessEvent_payload_check"
    CHECK (jsonb_typeof("payload") = 'object');

-- ---------------------------------------------------------------------------
-- Partial unique indexes: the referral rules themselves.
-- ---------------------------------------------------------------------------

-- A code identifies one inviter: a token hash is issued once.
CREATE UNIQUE INDEX "CashAccessEvent_issued_code_key"
  ON "CashAccessEvent" ("codeHash")
  WHERE "kind" = 'referral_code_issued';

-- One qualified invitation per invited person, whichever invitation it was.
CREATE UNIQUE INDEX "CashReferralAttribution_qualified_person_key"
  ON "CashReferralAttribution" ("inviteePersonKey")
  WHERE "state" = 'qualified';

-- ---------------------------------------------------------------------------
-- Append-only ledger.
-- ---------------------------------------------------------------------------

CREATE FUNCTION "cash_access_event_append_only"() RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'CashAccessEvent rows are append-only' USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "CashAccessEvent_append_only_row"
  BEFORE UPDATE OR DELETE ON "CashAccessEvent"
  FOR EACH ROW EXECUTE FUNCTION "cash_access_event_append_only"();

CREATE TRIGGER "CashAccessEvent_append_only_truncate"
  BEFORE TRUNCATE ON "CashAccessEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "cash_access_event_append_only"();

COMMIT;
