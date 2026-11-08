-- Fleet Operations-owned Cash referral: invitations a manager records.
--
-- Expand-only SOURCE migration. It creates one new table and widens the
-- admitted kinds of the existing CashAccessEvent ledger; it touches no other
-- table, adds no column to an existing table, carries no data statement and
-- no backfill, and changes no monetary table, constraint or rule. Production
-- application is a separate reviewed operation.
--
-- A manager records that one person invited another. The record is a row
-- here and a ledger event on the inviter's chain naming the signed staff
-- session that made it; a withdrawal is the row's one later change and a
-- second event. A record grants nothing: access is only ever the access kinds
-- of CashAccessEvent, which this migration leaves as they are. Telegram
-- invitations stay in CashReferralAttribution, untouched.

BEGIN;

-- CreateTable
CREATE TABLE "CashReferralManagerInvitation" (
    "id" TEXT NOT NULL,
    "inviterContactId" VARCHAR(255) NOT NULL,
    "inviterLineageDigest" VARCHAR(128) NOT NULL,
    "inviteeContactId" VARCHAR(255) NOT NULL,
    "state" VARCHAR(16) NOT NULL DEFAULT 'recorded',
    "recordedAt" TIMESTAMPTZ(3) NOT NULL,
    "withdrawnAt" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CashReferralManagerInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CashReferralManagerInvitation_inviter_idx" ON "CashReferralManagerInvitation"("inviterContactId", "recordedAt");

-- CreateIndex
CREATE INDEX "CashReferralManagerInvitation_invitee_idx" ON "CashReferralManagerInvitation"("inviteeContactId", "recordedAt");

ALTER TABLE "CashReferralManagerInvitation"
  ADD CONSTRAINT "CashReferralManagerInvitation_state_check"
    CHECK ("state" IN ('recorded', 'withdrawn')),
  ADD CONSTRAINT "CashReferralManagerInvitation_withdrawn_check"
    CHECK (("state" = 'withdrawn') = ("withdrawnAt" IS NOT NULL)),
  -- Nobody is recorded as their own invitee.
  ADD CONSTRAINT "CashReferralManagerInvitation_not_self_check"
    CHECK ("inviteeContactId" <> "inviterContactId"),
  ADD CONSTRAINT "CashReferralManagerInvitation_version_check"
    CHECK ("version" >= 0);

-- One standing record per invited contact: two managers cannot both record
-- the same person. A record withdrawn frees the invitee.
CREATE UNIQUE INDEX "CashReferralManagerInvitation_recorded_invitee_key"
  ON "CashReferralManagerInvitation" ("inviteeContactId")
  WHERE "state" = 'recorded';

-- ---------------------------------------------------------------------------
-- CashAccessEvent: the two manager kinds for a recorded invitation. Their
-- invitation is named in the payload; attributionId stays the Telegram
-- invitation's own column.
-- ---------------------------------------------------------------------------

ALTER TABLE "CashAccessEvent"
  DROP CONSTRAINT "CashAccessEvent_kind_check",
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
      'invitee_dismissal_observed',
      'referral_link_recorded',
      'referral_link_withdrawn'
    )),
  -- A CHECK admits a row whose expression is NULL, so every comparison on a
  -- nullable column below is made total: a staff kind without a capability
  -- is refused, not let through as unknown. The writer table is otherwise
  -- the one 20261101120000 created, with the two invitation kinds added.
  DROP CONSTRAINT "CashAccessEvent_writer_check",
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
        AND "actorCapability" IS NOT NULL
        AND "actorCapability" = 'cash.access.manage'
        AND "actorSessionId" IS NOT NULL
        AND "actorAuthenticatedAt" IS NOT NULL
        AND "reason" IS NOT NULL
        AND char_length(btrim("reason")) >= 10
      )
      OR (
        "kind" IN ('referral_sanctioned', 'referral_link_recorded', 'referral_link_withdrawn')
        AND "actorKind" = 'signed_staff_session'
        AND "actorCapability" IS NOT NULL
        AND "actorCapability" = 'cash.referral.qualify'
        AND "actorSessionId" IS NOT NULL
        AND "actorAuthenticatedAt" IS NOT NULL
        AND "reason" IS NOT NULL
        AND char_length(btrim("reason")) >= 10
      )
    ),
  -- A manager invitation event names its invitation, as text, in the payload.
  ADD CONSTRAINT "CashAccessEvent_invitation_check"
    CHECK (
      "kind" NOT IN ('referral_link_recorded', 'referral_link_withdrawn')
      OR COALESCE(jsonb_typeof("payload" -> 'invitationId') = 'string' AND char_length("payload" ->> 'invitationId') > 0, false)
    );

COMMIT;
