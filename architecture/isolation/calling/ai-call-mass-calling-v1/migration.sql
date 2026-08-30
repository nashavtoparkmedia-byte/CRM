-- YOKO AI Calls mass-calling foundation.
-- SOURCE/ISOLATED ONLY: this expand-only migration is intentionally outside
-- gravity-mvp/prisma/migrations because production migration authority remains
-- sealed at 20260809140000_add_domain_outbox.

CREATE TABLE "AiCallCampaign" (
  "id" TEXT NOT NULL,
  "identityKey" VARCHAR(255) NOT NULL,
  "payloadFingerprint" CHAR(64) NOT NULL,
  "name" VARCHAR(200) NOT NULL,
  "scenarioRef" VARCHAR(255) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'draft',
  "audienceSourceKind" VARCHAR(64),
  "audienceSourceRef" VARCHAR(255),
  "audienceSourceVersion" VARCHAR(255),
  "audienceFingerprint" CHAR(64),
  "audienceFrozenAt" TIMESTAMPTZ(3),
  "scheduledAt" TIMESTAMPTZ(3),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "cancelledAt" TIMESTAMPTZ(3),
  "concurrentLimit" INTEGER NOT NULL,
  "ratePerMinute" INTEGER NOT NULL,
  "maxAttempts" INTEGER NOT NULL,
  "retryBaseMs" INTEGER NOT NULL,
  "retryMaxMs" INTEGER NOT NULL,
  "nextAdmitAt" TIMESTAMPTZ(3),
  "failureCode" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiCallCampaign_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiCallCampaign_identityKey_key" UNIQUE ("identityKey"),
  CONSTRAINT "AiCallCampaign_state_check" CHECK ("state" IN (
    'draft', 'ready', 'scheduled', 'running', 'paused', 'cancelling',
    'completed', 'cancelled', 'failed'
  )),
  CONSTRAINT "AiCallCampaign_concurrentLimit_check" CHECK ("concurrentLimit" > 0),
  CONSTRAINT "AiCallCampaign_ratePerMinute_check" CHECK ("ratePerMinute" > 0),
  CONSTRAINT "AiCallCampaign_maxAttempts_check" CHECK ("maxAttempts" > 0),
  CONSTRAINT "AiCallCampaign_retry_bounds_check" CHECK (
    "retryBaseMs" > 0 AND "retryMaxMs" >= "retryBaseMs"
  )
);

CREATE INDEX "AiCallCampaign_state_scheduledAt_createdAt_idx"
  ON "AiCallCampaign" ("state", "scheduledAt", "createdAt");

CREATE TABLE "AiCallCampaignMember" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "memberKey" VARCHAR(320) NOT NULL,
  "targetType" VARCHAR(32) NOT NULL,
  "targetRef" VARCHAR(255) NOT NULL,
  "phoneE164" VARCHAR(32) NOT NULL,
  "provenance" JSONB NOT NULL,
  "snapshotFingerprint" CHAR(64) NOT NULL,
  "excludedReason" VARCHAR(128),
  "state" VARCHAR(32) NOT NULL,
  "attemptCount" INTEGER NOT NULL DEFAULT 0,
  "nextEligibleAt" TIMESTAMPTZ(3),
  "activeAttemptId" TEXT,
  "terminalEventId" VARCHAR(255),
  "terminalPayloadFingerprint" CHAR(64),
  "outcomeCode" VARCHAR(128),
  "failureCode" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiCallCampaignMember_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiCallCampaignMember_campaign_fkey" FOREIGN KEY ("campaignId")
    REFERENCES "AiCallCampaign" ("id") ON DELETE RESTRICT,
  CONSTRAINT "AiCallCampaignMember_campaign_member_key" UNIQUE ("campaignId", "memberKey"),
  CONSTRAINT "AiCallCampaignMember_campaign_target_key" UNIQUE (
    "campaignId", "targetType", "targetRef"
  ),
  CONSTRAINT "AiCallCampaignMember_targetType_check" CHECK (
    "targetType" IN ('contact', 'driver', 'external')
  ),
  CONSTRAINT "AiCallCampaignMember_state_check" CHECK ("state" IN (
    'pending', 'waiting', 'claimed', 'running', 'retry_wait',
    'succeeded', 'failed', 'excluded', 'cancelled'
  )),
  CONSTRAINT "AiCallCampaignMember_attemptCount_check" CHECK ("attemptCount" >= 0)
);

CREATE INDEX "AiCallCampaignMember_campaign_state_nextEligibleAt_id_idx"
  ON "AiCallCampaignMember" ("campaignId", "state", "nextEligibleAt", "id");

CREATE INDEX "AiCallCampaignMember_state_nextEligibleAt_id_idx"
  ON "AiCallCampaignMember" ("state", "nextEligibleAt", "id");

CREATE TABLE "AiCallCampaignAttempt" (
  "id" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "attemptNumber" INTEGER NOT NULL,
  "launchId" VARCHAR(255) NOT NULL,
  "state" VARCHAR(32) NOT NULL DEFAULT 'claimed',
  "claimRevision" INTEGER NOT NULL DEFAULT 1,
  "claimFence" CHAR(64),
  "claimedBy" VARCHAR(255),
  "claimUntil" TIMESTAMPTZ(3),
  "admissionLeaseId" TEXT,
  "dialEffectRef" VARCHAR(255),
  "resultEventId" VARCHAR(255),
  "resultFingerprint" CHAR(64),
  "failureCode" VARCHAR(128),
  "startedAt" TIMESTAMPTZ(3),
  "completedAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiCallCampaignAttempt_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiCallCampaignAttempt_campaign_fkey" FOREIGN KEY ("campaignId")
    REFERENCES "AiCallCampaign" ("id") ON DELETE RESTRICT,
  CONSTRAINT "AiCallCampaignAttempt_member_fkey" FOREIGN KEY ("memberId")
    REFERENCES "AiCallCampaignMember" ("id") ON DELETE RESTRICT,
  CONSTRAINT "AiCallCampaignAttempt_launchId_key" UNIQUE ("launchId"),
  CONSTRAINT "AiCallCampaignAttempt_member_attempt_key" UNIQUE ("memberId", "attemptNumber"),
  CONSTRAINT "AiCallCampaignAttempt_attemptNumber_check" CHECK ("attemptNumber" > 0),
  CONSTRAINT "AiCallCampaignAttempt_claimRevision_check" CHECK ("claimRevision" > 0),
  CONSTRAINT "AiCallCampaignAttempt_state_check" CHECK ("state" IN (
    'waiting', 'claimed', 'running', 'succeeded', 'retryable_failure',
    'permanent_failure', 'cancelled'
  ))
);

CREATE INDEX "AiCallCampaignAttempt_state_claimUntil_createdAt_idx"
  ON "AiCallCampaignAttempt" ("state", "claimUntil", "createdAt");

CREATE INDEX "AiCallCampaignAttempt_campaign_state_createdAt_idx"
  ON "AiCallCampaignAttempt" ("campaignId", "state", "createdAt");

ALTER TABLE "AiCallCampaignMember"
  ADD CONSTRAINT "AiCallCampaignMember_activeAttempt_fkey" FOREIGN KEY ("activeAttemptId")
  REFERENCES "AiCallCampaignAttempt" ("id") ON DELETE RESTRICT;

CREATE TABLE "AiCallAdmissionControl" (
  "id" TEXT NOT NULL,
  "concurrentLimit" INTEGER NOT NULL,
  "ratePerMinute" INTEGER NOT NULL,
  "nextAdmitAt" TIMESTAMPTZ(3),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiCallAdmissionControl_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiCallAdmissionControl_global_id_check" CHECK ("id" = 'global'),
  CONSTRAINT "AiCallAdmissionControl_concurrentLimit_check" CHECK ("concurrentLimit" > 0),
  CONSTRAINT "AiCallAdmissionControl_ratePerMinute_check" CHECK ("ratePerMinute" > 0)
);

CREATE TABLE "AiCallAdmissionLease" (
  "id" TEXT NOT NULL,
  "attemptId" TEXT NOT NULL,
  "campaignId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "workerId" VARCHAR(255) NOT NULL,
  "leaseFence" CHAR(64) NOT NULL,
  "acquiredAt" TIMESTAMPTZ(3) NOT NULL,
  "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
  "releasedAt" TIMESTAMPTZ(3),
  "releaseReason" VARCHAR(128),
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AiCallAdmissionLease_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AiCallAdmissionLease_attempt_key" UNIQUE ("attemptId"),
  CONSTRAINT "AiCallAdmissionLease_attempt_fkey" FOREIGN KEY ("attemptId")
    REFERENCES "AiCallCampaignAttempt" ("id") ON DELETE RESTRICT,
  CONSTRAINT "AiCallAdmissionLease_campaign_fkey" FOREIGN KEY ("campaignId")
    REFERENCES "AiCallCampaign" ("id") ON DELETE RESTRICT,
  CONSTRAINT "AiCallAdmissionLease_member_fkey" FOREIGN KEY ("memberId")
    REFERENCES "AiCallCampaignMember" ("id") ON DELETE RESTRICT
);

CREATE INDEX "AiCallAdmissionLease_releasedAt_leaseUntil_idx"
  ON "AiCallAdmissionLease" ("releasedAt", "leaseUntil");

CREATE INDEX "AiCallAdmissionLease_campaign_releasedAt_leaseUntil_idx"
  ON "AiCallAdmissionLease" ("campaignId", "releasedAt", "leaseUntil");
