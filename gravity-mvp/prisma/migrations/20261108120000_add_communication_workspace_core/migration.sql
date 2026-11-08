-- Communication Workspace-owned execution core (Communication Core + the Отток
-- host, first vertical slice).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery; production deployment remains a separate reviewed operation.
-- It adds six new Communication Workspace-owned tables and names, changes or
-- removes no existing object: projects (Flow + project policy), runs over one
-- host audience snapshot (one per idempotency key), the immutable audience
-- snapshot with each admission decision, one leased and versioned execution per
-- admitted canonical Contact per run, an append-only audit trail (one row per
-- dedupe key) and the cross-project contact guard (one active participation per
-- Contact and scope, plus its cooldown). No row stores a message body sent to a
-- provider, a conversation, a provider or transport identifier or a credential:
-- Contacts stay Contacts-owned and are referenced by canonical id only.

BEGIN;

-- CreateTable
CREATE TABLE "CommunicationProject" (
    "id" VARCHAR(64) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "title" VARCHAR(200) NOT NULL,
    "hostModule" VARCHAR(64) NOT NULL,
    "flowVersion" INTEGER NOT NULL,
    "flow" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationRun" (
    "id" VARCHAR(64) NOT NULL,
    "projectId" VARCHAR(64) NOT NULL,
    "idempotencyKey" VARCHAR(400) NOT NULL,
    "mode" VARCHAR(16) NOT NULL,
    "hostModule" VARCHAR(64) NOT NULL,
    "triggerKey" VARCHAR(128) NOT NULL,
    "triggerVersion" INTEGER NOT NULL,
    "snapshotRef" VARCHAR(200) NOT NULL,
    "snapshotSha256" CHAR(64) NOT NULL,
    "criteria" JSONB NOT NULL,
    "flowVersion" INTEGER NOT NULL,
    "flow" JSONB NOT NULL,
    "policy" JSONB NOT NULL,
    "sandbox" JSONB,
    "requestedBy" VARCHAR(128) NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationAudienceMember" (
    "id" VARCHAR(64) NOT NULL,
    "runId" VARCHAR(64) NOT NULL,
    "requestedContactId" VARCHAR(255) NOT NULL,
    "canonicalContactId" VARCHAR(255),
    "reason" VARCHAR(500) NOT NULL,
    "sourceRef" VARCHAR(200) NOT NULL,
    "businessContext" JSONB NOT NULL,
    "admission" VARCHAR(16) NOT NULL,
    "exclusionReason" VARCHAR(64),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationAudienceMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationParticipantExecution" (
    "id" VARCHAR(64) NOT NULL,
    "runId" VARCHAR(64) NOT NULL,
    "audienceMemberId" VARCHAR(64) NOT NULL,
    "canonicalContactId" VARCHAR(255) NOT NULL,
    "state" VARCHAR(32) NOT NULL,
    "nextActionAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 0,
    "leaseOwner" VARCHAR(128),
    "leaseUntil" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "messageRequestId" VARCHAR(128),
    "messageOutcome" VARCHAR(32),
    "messageAcceptedAt" TIMESTAMP(3),
    "callRequestId" VARCHAR(128),
    "callOutcome" VARCHAR(32),
    "outcome" VARCHAR(32),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationParticipantExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationExecutionEvent" (
    "id" VARCHAR(64) NOT NULL,
    "seq" SERIAL NOT NULL,
    "runId" VARCHAR(64) NOT NULL,
    "participantId" VARCHAR(64),
    "dedupeKey" VARCHAR(300) NOT NULL,
    "kind" VARCHAR(64) NOT NULL,
    "detail" JSONB NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationExecutionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationContactGuard" (
    "scope" VARCHAR(16) NOT NULL,
    "canonicalContactId" VARCHAR(255) NOT NULL,
    "activeParticipantId" VARCHAR(64),
    "activeProjectId" VARCHAR(64),
    "lastProjectId" VARCHAR(64),
    "cooldownUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationContactGuard_pkey" PRIMARY KEY ("scope","canonicalContactId")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationProject_key_key" ON "CommunicationProject"("key");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationRun_idempotencyKey_key" ON "CommunicationRun"("idempotencyKey");

-- CreateIndex
CREATE INDEX "CommunicationRun_project_idx" ON "CommunicationRun"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "CommunicationAudienceMember_run_admission_idx" ON "CommunicationAudienceMember"("runId", "admission");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAudienceMember_run_contact_key" ON "CommunicationAudienceMember"("runId", "requestedContactId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationParticipantExecution_audienceMemberId_key" ON "CommunicationParticipantExecution"("audienceMemberId");

-- CreateIndex
CREATE INDEX "CommunicationParticipantExecution_due_idx" ON "CommunicationParticipantExecution"("state", "nextActionAt");

-- CreateIndex
CREATE INDEX "CommunicationParticipantExecution_run_state_idx" ON "CommunicationParticipantExecution"("runId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationParticipantExecution_run_contact_key" ON "CommunicationParticipantExecution"("runId", "canonicalContactId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationExecutionEvent_dedupeKey_key" ON "CommunicationExecutionEvent"("dedupeKey");

-- CreateIndex
CREATE INDEX "CommunicationExecutionEvent_run_idx" ON "CommunicationExecutionEvent"("runId", "seq");

-- CreateIndex
CREATE INDEX "CommunicationExecutionEvent_participant_idx" ON "CommunicationExecutionEvent"("participantId", "seq");

-- Closed vocabularies, enforced by the database as well as by the owner.
ALTER TABLE "CommunicationRun" ADD CONSTRAINT "CommunicationRun_mode_check"
    CHECK ("mode" IN ('sandbox', 'live'));
ALTER TABLE "CommunicationAudienceMember" ADD CONSTRAINT "CommunicationAudienceMember_admission_check"
    CHECK ("admission" IN ('admitted', 'excluded'));
ALTER TABLE "CommunicationAudienceMember" ADD CONSTRAINT "CommunicationAudienceMember_exclusion_check"
    CHECK (("admission" = 'admitted') = ("exclusionReason" IS NULL));
ALTER TABLE "CommunicationParticipantExecution" ADD CONSTRAINT "CommunicationParticipantExecution_state_check"
    CHECK ("state" IN ('admitted', 'waiting_reply', 'calling', 'completed', 'blocked', 'needs_review', 'failed'));
ALTER TABLE "CommunicationParticipantExecution" ADD CONSTRAINT "CommunicationParticipantExecution_version_check"
    CHECK ("version" >= 0 AND "attempts" >= 0);
ALTER TABLE "CommunicationContactGuard" ADD CONSTRAINT "CommunicationContactGuard_scope_check"
    CHECK ("scope" IN ('sandbox', 'live'));

COMMIT;
