-- Fresh-install reconstruction of the multi-park driver identity and MAX mirroring schema.
--
-- WHY THIS MIGRATION EXISTS
-- =========================
-- The objects below are already applied in production and already governed in this
-- repository, but their migrations live in the pre-outbox archive
-- (architecture/migrations/v1/archive/pre-outbox/), which Prisma does not read.
-- `prisma migrate deploy` replays only gravity-mvp/prisma/migrations/, so a database
-- rebuilt from the active history alone came out 30 tables and 17 columns short of
-- gravity-mvp/prisma/schema.prisma. That broke disaster recovery, fresh environments and
-- CI databases. It never affected production.
--
-- AUTHORITY CATEGORY
-- ==================
-- Registered in architecture/migrations/v1/reconstruction-source-migrations.json, not in
-- the pending-source registry. Pending-source means "expected to execute against
-- production". This migration is the opposite: it executes on a fresh install and must
-- never execute against a database that already carries the governed historical objects.
--
--   fresh, empty database        -> executes normally
--   production / any catalog that already has ALL of these objects
--                                -> ABORTS (see the precondition below)
--                                -> reconcile with:
--                                   prisma migrate resolve --applied 20260911000000_fresh_install_parity_multi_park_and_max_mirror
--                                   then prisma migrate deploy
--   partially populated, unknown -> ABORTS, and resolve --applied is NOT the remedy
--
-- The abort is only clean under a transaction. Prisma wraps each migration file in one, so
-- `prisma migrate deploy` leaves the catalog untouched. A hand-run `psql -f` without
-- --single-transaction and ON_ERROR_STOP=1 will carry on past the abort and create objects,
-- so do not apply this file that way.
--
-- A refused deploy leaves an unfinished row in _prisma_migrations and blocks later deploys
-- until an operator runs `prisma migrate resolve --rolled-back 20260911000000_fresh_install_parity_multi_park_and_max_mirror`, then the
-- `--applied` step above. No schema damage, but it costs a deploy window.
--
-- DERIVATION
-- ==========
-- Tables, columns, indexes and foreign keys were generated mechanically with
-- `prisma migrate diff --to-schema-datamodel schema.prisma` against a PostgreSQL 16
-- database built by replaying the active migration history. CHECK constraints, guard
-- functions, guard triggers and partial unique indexes cannot be expressed in the Prisma
-- datamodel, so they were read out of the PostgreSQL catalog of a database built by this
-- repository's own canonical replay
-- (tools/architecture/replay-production-migration-authority.mjs), via
-- pg_get_constraintdef, pg_get_functiondef, pg_get_triggerdef and pg_indexes.
--
-- No statement was copied from an unmerged branch, and none of the data-repair statements
-- carried by some archived migrations is reproduced here. This file contains no INSERT,
-- UPDATE, DELETE, TRUNCATE, DROP or COPY.
--
-- CASCADE
-- =======
-- Three foreign keys use ON DELETE CASCADE:
--   ParkConnection_parkId_fkey, ParkConnection_apiConnectionId_fkey,
--   ContactDriverProfileAudit_contactId_fkey.
-- They are declared onDelete: Cascade in schema.prisma and already carry that referential
-- action in the canonical replay and in production. They are covered by a bounded Owner
-- exception, and no further ON DELETE CASCADE is introduced here.
--
-- ON UPDATE CASCADE appears on every foreign key below. That is Prisma's default for a
-- relation and is what the canonical replay and production already carry, so it is not
-- part of the exception and is not a new semantic.

-- Precondition: refuse to run unless this schema is a clean slate.
--
-- pg_class and pg_attribute are read rather than information_schema, because
-- information_schema filters by privilege: a role without rights on the existing objects
-- would see none of them and walk straight past this guard.
--
-- The remediation differs by case and must not be given generically. A catalog carrying
-- every reconstructed object is production, and is reconciled with resolve --applied. A
-- catalog carrying only some of them is not, and marking the migration applied there would
-- strand the rest permanently - the precise defect this migration exists to repair.
DO $$
DECLARE
    present_tables integer;
    present_columns integer;
BEGIN
    SELECT count(*) INTO present_tables
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p')
      AND c.relname IN ('Park', 'ParkConnection', 'MaxRawTransportEvent', 'MaxRawTransportProcessing', 'MaxRawTransportCursor', 'MaxInboundNormalizationResult', 'MaxInboundNormalizedEvent', 'MaxRouteConversation', 'MaxOutboundCommand', 'MaxAccountSessionOwner', 'MaxOutboundShadowPlan', 'MaxOutboundConversationActor', 'MaxOutboundCommandReservation', 'MaxOutboundDispatch', 'MaxOutboundDispatchLane', 'MaxOutboundDispatchAttempt', 'MaxOutboundDispatchTransition', 'MaxOutboundReconciliationTask', 'MaxProviderConfirmationEvidence', 'MaxProviderConfirmationResolution', 'MaxProviderConfirmationDecision', 'MaxProviderConfirmationCursor', 'MaxShadowComparisonRun', 'MaxShadowComparisonResult', 'MaxShadowSemanticDiff', 'MaxShadowComparisonCursor', 'MaxRouteIdentityBinding', 'MaxRouteObservation', 'MaxRouteConflict', 'ContactDriverProfileAudit');

    SELECT count(*) INTO present_columns
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relkind IN ('r', 'p')
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND (c.relname, a.attname) IN (('Contact', 'mainDriverId'), ('Contact', 'mainDriverSelection'), ('Contact', 'mainDriverSelectedBy'), ('Contact', 'mainDriverSelectedAt'), ('Driver', 'contactId'), ('Driver', 'externalDriverProfileId'), ('Driver', 'externalParkId'), ('Driver', 'parkId'), ('Driver', 'sourceConnectionId'), ('Driver', 'externalPersonKey'), ('Driver', 'personKeyType'), ('Driver', 'personResolutionStatus'), ('Driver', 'personResolutionBasis'), ('Driver', 'personResolutionAt'), ('Driver', 'personResolvedBy'), ('DriverTelegram', 'submittedPhone'), ('DriverTelegram', 'submittedPhoneAt'));

    IF present_tables = 30 AND present_columns = 17 THEN
        RAISE EXCEPTION
            'Reconstruction migration 20260911000000_fresh_install_parity_multi_park_and_max_mirror refused: this catalog already carries all 30 reconstruction tables and all 17 reconstruction columns.'
        USING
            ERRCODE = 'duplicate_table',
            HINT = 'This is the expected state for production. Reconcile without executing any DDL: prisma migrate resolve --applied 20260911000000_fresh_install_parity_multi_park_and_max_mirror   then prisma migrate deploy.';
    ELSIF present_tables > 0 OR present_columns > 0 THEN
        RAISE EXCEPTION
            'Reconstruction migration 20260911000000_fresh_install_parity_multi_park_and_max_mirror refused: this catalog is partially populated, carrying % of 30 reconstruction tables and % of 17 reconstruction columns.',
            present_tables, present_columns
        USING
            ERRCODE = 'duplicate_table',
            HINT = 'Do NOT run prisma migrate resolve --applied here: marking this migration applied would strand the objects that are still missing. Establish why this catalog is partially populated first.';
    END IF;
END $$;

-- AlterTable
ALTER TABLE "Contact" ADD COLUMN     "mainDriverId" TEXT,
ADD COLUMN     "mainDriverSelection" TEXT NOT NULL DEFAULT 'auto',
ADD COLUMN     "mainDriverSelectedBy" TEXT,
ADD COLUMN     "mainDriverSelectedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Driver" ADD COLUMN     "contactId" TEXT,
ADD COLUMN     "externalDriverProfileId" TEXT,
ADD COLUMN     "externalParkId" TEXT,
ADD COLUMN     "parkId" TEXT,
ADD COLUMN     "sourceConnectionId" TEXT,
ADD COLUMN     "externalPersonKey" TEXT,
ADD COLUMN     "personKeyType" TEXT,
ADD COLUMN     "personResolutionStatus" TEXT NOT NULL DEFAULT 'unlinked',
ADD COLUMN     "personResolutionBasis" TEXT,
ADD COLUMN     "personResolutionAt" TIMESTAMP(3),
ADD COLUMN     "personResolvedBy" TEXT;

-- AlterTable
ALTER TABLE "DriverTelegram" ADD COLUMN     "submittedPhone" TEXT,
ADD COLUMN     "submittedPhoneAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Park" (
    "id" TEXT NOT NULL,
    "parkCode" TEXT NOT NULL,
    "parkName" TEXT NOT NULL,
    "externalParkId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Park_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ParkConnection" (
    "id" TEXT NOT NULL,
    "parkId" TEXT NOT NULL,
    "apiConnectionId" TEXT NOT NULL,
    "externalParkId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastFailedSyncAt" TIMESTAMP(3),
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ParkConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaxRawTransportEvent" (
    "observationId" TEXT NOT NULL,
    "journalSequence" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
    "captureEnvelopeId" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "persistedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sourceTransport" TEXT NOT NULL,
    "sourceOrigin" TEXT NOT NULL,
    "historyLive" TEXT NOT NULL,
    "socketGeneration" TEXT,
    "frameId" TEXT,
    "providerEventId" TEXT,
    "transportSequence" TEXT,
    "opcode" INTEGER,
    "eventType" TEXT,
    "payloadEncoding" TEXT NOT NULL,
    "sanitizedPayload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "payloadSizeBytes" INTEGER NOT NULL,
    "replayAvailability" TEXT NOT NULL DEFAULT 'available',
    "quarantineReason" TEXT,
    "sanitizerVersion" TEXT NOT NULL,
    "captureAdapterVersion" TEXT NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "correlationMetadata" JSONB,
    "redactionMetadata" JSONB NOT NULL,
    "quarantineEligible" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "MaxRawTransportEvent_pkey" PRIMARY KEY ("observationId")
);

-- CreateTable
CREATE TABLE "MaxRawTransportProcessing" (
    "id" TEXT NOT NULL,
    "observationId" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "claimedBy" TEXT,
    "claimedAt" TIMESTAMP(3),
    "leaseUntil" TIMESTAMP(3),
    "leaseVersion" INTEGER NOT NULL DEFAULT 0,
    "completedAt" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "lastErrorSummary" TEXT,
    "quarantineReason" TEXT,
    "replayMetadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxRawTransportProcessing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaxRawTransportCursor" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "lastJournalSequence" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxRawTransportCursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaxInboundNormalizationResult" (
    "normalizationResultId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceObservationId" TEXT NOT NULL,
    "sourceJournalSequence" BIGINT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "envelopeVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "eventCount" INTEGER NOT NULL,
    "issueCode" TEXT,
    "safeIssueSummary" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxInboundNormalizationResult_pkey" PRIMARY KEY ("normalizationResultId")
);

-- CreateTable
CREATE TABLE "MaxInboundNormalizedEvent" (
    "normalizedEventId" TEXT NOT NULL,
    "normalizationResultId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceObservationId" TEXT NOT NULL,
    "sourceJournalSequence" BIGINT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "envelopeVersion" TEXT NOT NULL,
    "eventOrdinal" INTEGER NOT NULL,
    "eventKind" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "providerUserId" TEXT,
    "protocolChatId" TEXT,
    "webRouteId" TEXT,
    "clientMessageId" TEXT,
    "targetProviderMessageId" TEXT,
    "providerOccurredAt" TIMESTAMP(3),
    "normalizedPayload" JSONB NOT NULL,
    "semanticSha256" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxInboundNormalizedEvent_pkey" PRIMARY KEY ("normalizedEventId")
);

-- CreateTable
CREATE TABLE "MaxRouteConversation" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL DEFAULT 0,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "state" TEXT NOT NULL DEFAULT 'unresolved',
    "retiredAt" TIMESTAMP(3),
    "retiredBy" TEXT,
    "retirementReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxRouteConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaxOutboundCommand" (
    "commandId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "clientMessageId" TEXT,
    "commandSequence" INTEGER NOT NULL,
    "commandKind" TEXT NOT NULL,
    "envelopeVersion" TEXT NOT NULL,
    "commandPayload" JSONB NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxOutboundCommand_pkey" PRIMARY KEY ("commandId")
);

-- CreateTable
CREATE TABLE "MaxAccountSessionOwner" (
    "accountId" TEXT NOT NULL,
    "ownerInstanceId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "lastReleasedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxAccountSessionOwner_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "MaxOutboundShadowPlan" (
    "planId" TEXT NOT NULL,
    "schemaVersion" TEXT NOT NULL,
    "inputSha256" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "accountAliasSha256" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "conversationKeySha256" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "commandSequence" INTEGER NOT NULL,
    "reservationId" TEXT NOT NULL,
    "clientMessageId" TEXT,
    "attemptCorrelationId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "routeResolution" TEXT NOT NULL,
    "routeVersion" INTEGER,
    "selectedProtocolChatId" TEXT,
    "payloadKind" TEXT NOT NULL,
    "payloadSizeBytes" INTEGER NOT NULL,
    "payloadSha256" TEXT NOT NULL,
    "replyMetadata" TEXT NOT NULL,
    "ownerReadiness" TEXT NOT NULL,
    "ownerInstanceId" TEXT,
    "ownerFencingToken" BIGINT,
    "wouldSend" BOOLEAN NOT NULL,
    "refusalReason" TEXT,
    "semanticComparison" JSONB NOT NULL,
    "evaluatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxOutboundShadowPlan_pkey" PRIMARY KEY ("planId")
);

-- CreateTable
CREATE TABLE "MaxOutboundConversationActor" (
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "nextCommandSequence" INTEGER NOT NULL DEFAULT 0,
    "nextHandoffSequence" INTEGER NOT NULL DEFAULT 1,
    "leaseOwnerId" TEXT,
    "leaseEpoch" INTEGER NOT NULL DEFAULT 0,
    "leaseUntil" TIMESTAMP(3),
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundConversationActor_pkey" PRIMARY KEY ("accountId","conversationKey")
);

-- CreateTable
CREATE TABLE "MaxOutboundCommandReservation" (
    "reservationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "commandSequence" INTEGER NOT NULL,
    "leaseOwnerId" TEXT NOT NULL,
    "leaseEpoch" INTEGER NOT NULL,
    "reservationState" TEXT NOT NULL,
    "reservationVersion" INTEGER NOT NULL DEFAULT 0,
    "reservedAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "handoffReference" TEXT,
    "handedOffAt" TIMESTAMP(3),
    "dispatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundCommandReservation_pkey" PRIMARY KEY ("reservationId")
);

-- CreateTable
CREATE TABLE "MaxOutboundDispatch" (
    "dispatchId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "commandId" TEXT NOT NULL,
    "commandSequence" INTEGER NOT NULL,
    "reservationId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "stateVersion" INTEGER NOT NULL,
    "initialRouteVersion" INTEGER NOT NULL,
    "initialProtocolChatId" TEXT NOT NULL,
    "initialProviderUserId" TEXT,
    "initialWebRouteId" TEXT,
    "initialRouteEvidence" JSONB NOT NULL,
    "initialRouteSnapshotSha256" TEXT NOT NULL,
    "currentAttemptId" TEXT,
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "providerMessageId" TEXT,
    "providerConfirmedAt" TIMESTAMP(3),
    "reconciliationRequiredAt" TIMESTAMP(3),
    "terminalAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundDispatch_pkey" PRIMARY KEY ("dispatchId")
);

-- CreateTable
CREATE TABLE "MaxOutboundDispatchLane" (
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "nextPhysicalSequence" INTEGER NOT NULL DEFAULT 1,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundDispatchLane_pkey" PRIMARY KEY ("accountId","conversationKey")
);

-- CreateTable
CREATE TABLE "MaxOutboundDispatchAttempt" (
    "attemptId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "attemptState" TEXT NOT NULL,
    "attemptVersion" INTEGER NOT NULL DEFAULT 0,
    "senderOwnerId" TEXT NOT NULL,
    "senderFencingEpoch" INTEGER NOT NULL,
    "senderAuthorityVerifiedAt" TIMESTAMP(3) NOT NULL,
    "attemptCorrelationId" TEXT NOT NULL,
    "routeVersion" INTEGER NOT NULL,
    "protocolChatId" TEXT NOT NULL,
    "providerUserId" TEXT,
    "webRouteId" TEXT,
    "routeSnapshotSha256" TEXT NOT NULL,
    "preparedAt" TIMESTAMP(3) NOT NULL,
    "claimUntil" TIMESTAMP(3) NOT NULL,
    "physicalActionStartedAt" TIMESTAMP(3),
    "clientActionAcceptedAt" TIMESTAMP(3),
    "awaitingConfirmationAt" TIMESTAMP(3),
    "outcomeUnknownAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "safeErrorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundDispatchAttempt_pkey" PRIMARY KEY ("attemptId")
);

-- CreateTable
CREATE TABLE "MaxOutboundDispatchTransition" (
    "transitionId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "attemptId" TEXT,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "transitionSequence" INTEGER NOT NULL,
    "transitionIdempotencyKey" TEXT NOT NULL,
    "fromState" TEXT,
    "toState" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "evidenceSha256" TEXT NOT NULL,
    "safeEvidenceMetadata" JSONB NOT NULL,
    "stateVersionBefore" INTEGER NOT NULL,
    "stateVersionAfter" INTEGER NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxOutboundDispatchTransition_pkey" PRIMARY KEY ("transitionId")
);

-- CreateTable
CREATE TABLE "MaxOutboundReconciliationTask" (
    "reconciliationId" TEXT NOT NULL,
    "dispatchId" TEXT NOT NULL,
    "attemptId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "taskVersion" INTEGER NOT NULL DEFAULT 0,
    "openedAt" TIMESTAMP(3) NOT NULL,
    "notBefore" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolutionType" TEXT,
    "resolutionEvidenceReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxOutboundReconciliationTask_pkey" PRIMARY KEY ("reconciliationId")
);

-- CreateTable
CREATE TABLE "MaxProviderConfirmationEvidence" (
    "evidenceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceNormalizedEventId" TEXT NOT NULL,
    "sourceObservationId" TEXT NOT NULL,
    "sourceJournalSequence" BIGINT NOT NULL,
    "sourceEventOrdinal" INTEGER NOT NULL,
    "matcherVersion" TEXT NOT NULL,
    "evidenceVersion" TEXT NOT NULL,
    "evidenceKind" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "attemptCorrelationId" TEXT,
    "clientMessageId" TEXT,
    "protocolChatId" TEXT,
    "providerUserId" TEXT,
    "webRouteId" TEXT,
    "providerOccurredAt" TIMESTAMP(3),
    "evidenceSha256" TEXT NOT NULL,
    "safeMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxProviderConfirmationEvidence_pkey" PRIMARY KEY ("evidenceId")
);

-- CreateTable
CREATE TABLE "MaxProviderConfirmationResolution" (
    "resolutionId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "matcherVersion" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "matchMethod" TEXT NOT NULL,
    "dispatchId" TEXT,
    "attemptId" TEXT,
    "transitionId" TEXT,
    "canonicalEvidenceId" TEXT,
    "issueCode" TEXT,
    "safeIssueSummary" TEXT,
    "candidateDispatchIds" JSONB NOT NULL,
    "candidateAttemptIds" JSONB NOT NULL,
    "resolutionVersion" INTEGER NOT NULL DEFAULT 0,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "nextRetryAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxProviderConfirmationResolution_pkey" PRIMARY KEY ("resolutionId")
);

-- CreateTable
CREATE TABLE "MaxProviderConfirmationDecision" (
    "decisionId" TEXT NOT NULL,
    "resolutionId" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "decisionSequence" INTEGER NOT NULL,
    "matcherVersion" TEXT NOT NULL,
    "decisionType" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "dispatchId" TEXT,
    "attemptId" TEXT,
    "transitionId" TEXT,
    "actor" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "decisionSha256" TEXT NOT NULL,
    "safeMetadata" JSONB NOT NULL,
    "resolutionVersionBefore" INTEGER NOT NULL,
    "resolutionVersionAfter" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxProviderConfirmationDecision_pkey" PRIMARY KEY ("decisionId")
);

-- CreateTable
CREATE TABLE "MaxProviderConfirmationCursor" (
    "cursorId" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "matcherVersion" TEXT NOT NULL,
    "lastJournalSequence" BIGINT NOT NULL DEFAULT 0,
    "lastEventOrdinal" INTEGER NOT NULL DEFAULT 0,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxProviderConfirmationCursor_pkey" PRIMARY KEY ("cursorId")
);

-- CreateTable
CREATE TABLE "MaxShadowComparisonRun" (
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "legacyAdapterVersion" TEXT NOT NULL,
    "newNormalizerVersion" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'running',
    "sourceFromJournalSequence" BIGINT,
    "sourceToJournalSequence" BIGINT,
    "processedCount" INTEGER NOT NULL DEFAULT 0,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "expectedDifferenceCount" INTEGER NOT NULL DEFAULT 0,
    "regressionCount" INTEGER NOT NULL DEFAULT 0,
    "legacyOnlyCount" INTEGER NOT NULL DEFAULT 0,
    "newOnlyCount" INTEGER NOT NULL DEFAULT 0,
    "unsupportedCount" INTEGER NOT NULL DEFAULT 0,
    "quarantinedCount" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxShadowComparisonRun_pkey" PRIMARY KEY ("runId")
);

-- CreateTable
CREATE TABLE "MaxShadowComparisonResult" (
    "resultId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sourceObservationId" TEXT NOT NULL,
    "sourceJournalSequence" BIGINT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "classification" TEXT NOT NULL,
    "legacyStatus" TEXT NOT NULL,
    "newStatus" TEXT NOT NULL,
    "legacySemanticSha256" TEXT NOT NULL,
    "newSemanticSha256" TEXT NOT NULL,
    "diffCount" INTEGER NOT NULL,
    "highestSeverity" TEXT NOT NULL,
    "issueCode" TEXT,
    "safeSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxShadowComparisonResult_pkey" PRIMARY KEY ("resultId")
);

-- CreateTable
CREATE TABLE "MaxShadowSemanticDiff" (
    "diffId" TEXT NOT NULL,
    "resultId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "diffOrdinal" INTEGER NOT NULL,
    "path" TEXT NOT NULL,
    "differenceKind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "legacyValueType" TEXT NOT NULL,
    "newValueType" TEXT NOT NULL,
    "legacyValueHash" TEXT,
    "newValueHash" TEXT,
    "safeMetadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxShadowSemanticDiff_pkey" PRIMARY KEY ("diffId")
);

-- CreateTable
CREATE TABLE "MaxShadowComparisonCursor" (
    "cursorId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "comparisonVersion" TEXT NOT NULL,
    "lastJournalSequence" BIGINT NOT NULL DEFAULT 0,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxShadowComparisonCursor_pkey" PRIMARY KEY ("cursorId")
);

-- CreateTable
CREATE TABLE "MaxRouteIdentityBinding" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "identityKind" TEXT NOT NULL,
    "identityValue" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'provisional',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MaxRouteIdentityBinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MaxRouteObservation" (
    "routeObservationId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "sourceRawObservationId" TEXT,
    "extractorVersion" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "evidenceSource" TEXT NOT NULL,
    "evidenceAuthority" TEXT NOT NULL,
    "candidateConversationKey" TEXT,
    "identityKind" TEXT NOT NULL,
    "identityValue" TEXT NOT NULL,
    "sanitizedEvidence" JSONB NOT NULL,
    "evidenceSha256" TEXT NOT NULL,
    "evidenceSizeBytes" INTEGER NOT NULL,
    "evidenceQuarantined" BOOLEAN NOT NULL DEFAULT false,
    "redactionMetadata" JSONB NOT NULL,
    "processingResult" TEXT NOT NULL,
    "routeVersionAfter" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxRouteObservation_pkey" PRIMARY KEY ("routeObservationId")
);

-- CreateTable
CREATE TABLE "MaxRouteConflict" (
    "conflictId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "identityKind" TEXT NOT NULL,
    "identityValue" TEXT NOT NULL,
    "incumbentConversationKey" TEXT NOT NULL,
    "candidateConversationKey" TEXT NOT NULL,
    "sourceRouteObservationId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "expectedRouteVersion" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolutionReason" TEXT,
    "resolvedBy" TEXT,
    "auditMetadata" JSONB,

    CONSTRAINT "MaxRouteConflict_pkey" PRIMARY KEY ("conflictId")
);

-- CreateTable
CREATE TABLE "ContactDriverProfileAudit" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "driverId" TEXT,
    "previousMainDriverId" TEXT,
    "action" TEXT NOT NULL,
    "selectedBy" TEXT NOT NULL DEFAULT 'system',
    "reason" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactDriverProfileAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Park_parkCode_key" ON "Park"("parkCode");

-- CreateIndex
CREATE UNIQUE INDEX "Park_externalParkId_key" ON "Park"("externalParkId");

-- CreateIndex
CREATE INDEX "ParkConnection_parkId_enabled_idx" ON "ParkConnection"("parkId", "enabled");

-- CreateIndex
CREATE INDEX "ParkConnection_externalParkId_idx" ON "ParkConnection"("externalParkId");

-- CreateIndex
CREATE UNIQUE INDEX "ParkConnection_apiConnectionId_archivedAt_key" ON "ParkConnection"("apiConnectionId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRawTransportEvent_journalSequence_key" ON "MaxRawTransportEvent"("journalSequence");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_captureEnvelopeId_idx" ON "MaxRawTransportEvent"("accountId", "captureEnvelopeId");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_journalSequence_idx" ON "MaxRawTransportEvent"("accountId", "journalSequence");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_observedAt_idx" ON "MaxRawTransportEvent"("accountId", "observedAt");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_providerEventId_idx" ON "MaxRawTransportEvent"("accountId", "providerEventId");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_frameId_idx" ON "MaxRawTransportEvent"("accountId", "frameId");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_accountId_transportSequence_idx" ON "MaxRawTransportEvent"("accountId", "transportSequence");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_payloadSha256_idx" ON "MaxRawTransportEvent"("payloadSha256");

-- CreateIndex
CREATE INDEX "MaxRawTransportEvent_opcode_idx" ON "MaxRawTransportEvent"("opcode");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRawTransportEvent_accountId_observationId_key" ON "MaxRawTransportEvent"("accountId", "observationId");

-- CreateIndex
CREATE INDEX "MaxRawTransportProcessing_state_leaseUntil_idx" ON "MaxRawTransportProcessing"("state", "leaseUntil");

-- CreateIndex
CREATE INDEX "MaxRawTransportProcessing_claimedBy_leaseUntil_idx" ON "MaxRawTransportProcessing"("claimedBy", "leaseUntil");

-- CreateIndex
CREATE INDEX "MaxRawTransportProcessing_parserVersion_state_idx" ON "MaxRawTransportProcessing"("parserVersion", "state");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRawTransportProcessing_observationId_parserVersion_key" ON "MaxRawTransportProcessing"("observationId", "parserVersion");

-- CreateIndex
CREATE INDEX "MaxRawTransportCursor_accountId_lastJournalSequence_idx" ON "MaxRawTransportCursor"("accountId", "lastJournalSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRawTransportCursor_consumerId_accountId_parserVersion_key" ON "MaxRawTransportCursor"("consumerId", "accountId", "parserVersion");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizationResult_account_sequence_idx" ON "MaxInboundNormalizationResult"("accountId", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizationResult_account_parser_sequence_idx" ON "MaxInboundNormalizationResult"("accountId", "parserVersion", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizationResult_status_idx" ON "MaxInboundNormalizationResult"("status");

-- CreateIndex
CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_source_parser_key" ON "MaxInboundNormalizationResult"("accountId", "sourceObservationId", "parserVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_result_key" ON "MaxInboundNormalizationResult"("accountId", "normalizationResultId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_result_source_parser_key" ON "MaxInboundNormalizationResult"("accountId", "normalizationResultId", "sourceObservationId", "parserVersion");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_account_sequence_idx" ON "MaxInboundNormalizedEvent"("accountId", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_account_parser_sequence_idx" ON "MaxInboundNormalizedEvent"("accountId", "parserVersion", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_account_provider_message_idx" ON "MaxInboundNormalizedEvent"("accountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_account_protocol_chat_idx" ON "MaxInboundNormalizedEvent"("accountId", "protocolChatId");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_account_provider_user_idx" ON "MaxInboundNormalizedEvent"("accountId", "providerUserId");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_target_provider_message_idx" ON "MaxInboundNormalizedEvent"("targetProviderMessageId");

-- CreateIndex
CREATE INDEX "MaxInboundNormalizedEvent_kind_idx" ON "MaxInboundNormalizedEvent"("eventKind");

-- CreateIndex
CREATE UNIQUE INDEX "MaxInboundNormalizedEvent_result_ordinal_key" ON "MaxInboundNormalizedEvent"("normalizationResultId", "eventOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "MaxInboundNormalizedEvent_account_event_key" ON "MaxInboundNormalizedEvent"("accountId", "normalizedEventId");

-- CreateIndex
CREATE INDEX "MaxRouteConversation_accountId_state_idx" ON "MaxRouteConversation"("accountId", "state");

-- CreateIndex
CREATE INDEX "MaxRouteConversation_accountId_routeVersion_idx" ON "MaxRouteConversation"("accountId", "routeVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRouteConversation_accountId_conversationKey_key" ON "MaxRouteConversation"("accountId", "conversationKey");

-- CreateIndex
CREATE INDEX "MaxOutboundCommand_account_conversation_created_idx" ON "MaxOutboundCommand"("accountId", "conversationKey", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundCommand_account_conversation_sequence_key" ON "MaxOutboundCommand"("accountId", "conversationKey", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundCommand_account_conversation_command_sequence_key" ON "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence");

-- CreateIndex
CREATE INDEX "MaxAccountSessionOwner_state_lease_idx" ON "MaxAccountSessionOwner"("state", "leaseUntil");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundShadowPlan_command_key" ON "MaxOutboundShadowPlan"("commandId");

-- CreateIndex
CREATE INDEX "MaxOutboundShadowPlan_account_conversation_sequence_idx" ON "MaxOutboundShadowPlan"("accountId", "conversationKey", "commandSequence");

-- CreateIndex
CREATE INDEX "MaxOutboundShadowPlan_account_decision_idx" ON "MaxOutboundShadowPlan"("accountId", "wouldSend", "refusalReason");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundShadowPlan_command_identity_key" ON "MaxOutboundShadowPlan"("accountId", "conversationKey", "commandId", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundShadowPlan_account_idempotency_key" ON "MaxOutboundShadowPlan"("accountId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "MaxOutboundConversationActor_lease_until_idx" ON "MaxOutboundConversationActor"("leaseUntil");

-- CreateIndex
CREATE INDEX "MaxOutboundCommandReservation_state_lease_idx" ON "MaxOutboundCommandReservation"("reservationState", "leaseUntil");

-- CreateIndex
CREATE INDEX "MaxOutboundCommandReservation_account_conversation_sequence_idx" ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_source_key" ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_key" ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_command_key" ON "MaxOutboundDispatch"("commandId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_reservation_key" ON "MaxOutboundDispatch"("reservationId");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatch_account_conversation_state_sequence_idx" ON "MaxOutboundDispatch"("accountId", "conversationKey", "state", "commandSequence");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatch_state_reconciliation_idx" ON "MaxOutboundDispatch"("state", "reconciliationRequiredAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_account_conversation_sequence_key" ON "MaxOutboundDispatch"("accountId", "conversationKey", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_account_conversation_dispatch_key" ON "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_command_identity_key" ON "MaxOutboundDispatch"("accountId", "conversationKey", "commandId", "commandSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatch_reservation_identity_key" ON "MaxOutboundDispatch"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatchAttempt_state_claim_idx" ON "MaxOutboundDispatchAttempt"("attemptState", "claimUntil");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatchAttempt_account_conversation_state_idx" ON "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptState");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_dispatch_number_key" ON "MaxOutboundDispatchAttempt"("dispatchId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_account_dispatch_correlation_key" ON "MaxOutboundDispatchAttempt"("accountId", "dispatchId", "attemptCorrelationId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_account_conversation_attempt_key" ON "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatchTransition_account_conversation_occurred_idx" ON "MaxOutboundDispatchTransition"("accountId", "conversationKey", "occurredAt");

-- CreateIndex
CREATE INDEX "MaxOutboundDispatchTransition_attempt_idx" ON "MaxOutboundDispatchTransition"("attemptId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatchTransition_dispatch_sequence_key" ON "MaxOutboundDispatchTransition"("dispatchId", "transitionSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxOutboundDispatchTransition_idempotency_key" ON "MaxOutboundDispatchTransition"("accountId", "dispatchId", "transitionIdempotencyKey");

-- CreateIndex
CREATE INDEX "MaxOutboundReconciliationTask_state_not_before_idx" ON "MaxOutboundReconciliationTask"("state", "notBefore", "openedAt");

-- CreateIndex
CREATE INDEX "MaxOutboundReconciliationTask_account_conversation_state_idx" ON "MaxOutboundReconciliationTask"("accountId", "conversationKey", "state");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationEvidence_account_source_order_idx" ON "MaxProviderConfirmationEvidence"("accountId", "sourceJournalSequence", "sourceEventOrdinal");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationEvidence_account_provider_message_idx" ON "MaxProviderConfirmationEvidence"("accountId", "providerMessageId");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationEvidence_account_attempt_correlation_idx" ON "MaxProviderConfirmationEvidence"("accountId", "attemptCorrelationId");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationEvidence_account_client_message_idx" ON "MaxProviderConfirmationEvidence"("accountId", "clientMessageId");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationEvidence_kind_created_idx" ON "MaxProviderConfirmationEvidence"("evidenceKind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxProviderConfirmationEvidence_account_event_matcher_key" ON "MaxProviderConfirmationEvidence"("accountId", "sourceNormalizedEventId", "matcherVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MaxProviderConfirmationResolution_evidence_key" ON "MaxProviderConfirmationResolution"("evidenceId");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationResolution_account_matcher_status_idx" ON "MaxProviderConfirmationResolution"("accountId", "matcherVersion", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationResolution_dispatch_status_idx" ON "MaxProviderConfirmationResolution"("dispatchId", "status");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationResolution_canonical_evidence_idx" ON "MaxProviderConfirmationResolution"("canonicalEvidenceId");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationDecision_account_created_idx" ON "MaxProviderConfirmationDecision"("accountId", "createdAt");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationDecision_evidence_idx" ON "MaxProviderConfirmationDecision"("evidenceId", "createdAt");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationDecision_dispatch_idx" ON "MaxProviderConfirmationDecision"("dispatchId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxProviderConfirmationDecision_resolution_sequence_key" ON "MaxProviderConfirmationDecision"("resolutionId", "decisionSequence");

-- CreateIndex
CREATE INDEX "MaxProviderConfirmationCursor_account_source_order_idx" ON "MaxProviderConfirmationCursor"("accountId", "lastJournalSequence", "lastEventOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "MaxProviderConfirmationCursor_consumer_account_matcher_key" ON "MaxProviderConfirmationCursor"("consumerId", "accountId", "matcherVersion");

-- CreateIndex
CREATE INDEX "MaxShadowComparisonRun_account_version_state_idx" ON "MaxShadowComparisonRun"("accountId", "comparisonVersion", "state", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowComparisonRun_account_run_version_key" ON "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion");

-- CreateIndex
CREATE INDEX "MaxShadowComparisonResult_account_sequence_idx" ON "MaxShadowComparisonResult"("accountId", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxShadowComparisonResult_account_version_class_idx" ON "MaxShadowComparisonResult"("accountId", "comparisonVersion", "classification", "sourceJournalSequence");

-- CreateIndex
CREATE INDEX "MaxShadowComparisonResult_run_class_idx" ON "MaxShadowComparisonResult"("runId", "classification");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowComparisonResult_run_source_version_key" ON "MaxShadowComparisonResult"("runId", "sourceObservationId", "comparisonVersion");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowComparisonResult_account_result_key" ON "MaxShadowComparisonResult"("accountId", "resultId");

-- CreateIndex
CREATE INDEX "MaxShadowSemanticDiff_account_severity_idx" ON "MaxShadowSemanticDiff"("accountId", "severity", "createdAt");

-- CreateIndex
CREATE INDEX "MaxShadowSemanticDiff_result_path_idx" ON "MaxShadowSemanticDiff"("resultId", "path");

-- CreateIndex
CREATE INDEX "MaxShadowSemanticDiff_kind_idx" ON "MaxShadowSemanticDiff"("differenceKind");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowSemanticDiff_result_ordinal_key" ON "MaxShadowSemanticDiff"("resultId", "diffOrdinal");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowComparisonCursor_run_key" ON "MaxShadowComparisonCursor"("runId");

-- CreateIndex
CREATE INDEX "MaxShadowComparisonCursor_account_version_sequence_idx" ON "MaxShadowComparisonCursor"("accountId", "comparisonVersion", "lastJournalSequence");

-- CreateIndex
CREATE UNIQUE INDEX "MaxShadowComparisonCursor_account_run_version_key" ON "MaxShadowComparisonCursor"("accountId", "runId", "comparisonVersion");

-- CreateIndex
CREATE INDEX "MaxRouteIdentityBinding_accountId_conversationKey_status_idx" ON "MaxRouteIdentityBinding"("accountId", "conversationKey", "status");

-- CreateIndex
CREATE INDEX "MaxRouteIdentityBinding_accountId_identityKind_status_idx" ON "MaxRouteIdentityBinding"("accountId", "identityKind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRouteIdentityBinding_accountId_identityKind_identityValu_key" ON "MaxRouteIdentityBinding"("accountId", "identityKind", "identityValue");

-- CreateIndex
CREATE INDEX "MaxRouteObservation_sourceRawObservationId_idx" ON "MaxRouteObservation"("sourceRawObservationId");

-- CreateIndex
CREATE INDEX "MaxRouteObservation_accountId_observedAt_idx" ON "MaxRouteObservation"("accountId", "observedAt");

-- CreateIndex
CREATE INDEX "MaxRouteObservation_accountId_candidateConversationKey_idx" ON "MaxRouteObservation"("accountId", "candidateConversationKey");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRouteObservation_accountId_idempotencyKey_key" ON "MaxRouteObservation"("accountId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRouteObservation_accountId_routeObservationId_key" ON "MaxRouteObservation"("accountId", "routeObservationId");

-- CreateIndex
CREATE INDEX "MaxRouteConflict_accountId_status_createdAt_idx" ON "MaxRouteConflict"("accountId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "MaxRouteConflict_accountId_identityKind_identityValue_statu_idx" ON "MaxRouteConflict"("accountId", "identityKind", "identityValue", "status");

-- CreateIndex
CREATE INDEX "MaxRouteConflict_accountId_incumbentConversationKey_status_idx" ON "MaxRouteConflict"("accountId", "incumbentConversationKey", "status");

-- CreateIndex
CREATE INDEX "MaxRouteConflict_accountId_candidateConversationKey_status_idx" ON "MaxRouteConflict"("accountId", "candidateConversationKey", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MaxRouteConflict_accountId_sourceRouteObservationId_key" ON "MaxRouteConflict"("accountId", "sourceRouteObservationId");

-- CreateIndex
CREATE INDEX "ContactDriverProfileAudit_contactId_createdAt_idx" ON "ContactDriverProfileAudit"("contactId", "createdAt");

-- CreateIndex
CREATE INDEX "ContactDriverProfileAudit_driverId_idx" ON "ContactDriverProfileAudit"("driverId");

-- CreateIndex
CREATE UNIQUE INDEX "Contact_mainDriverId_key" ON "Contact"("mainDriverId");

-- CreateIndex
CREATE INDEX "Driver_contactId_idx" ON "Driver"("contactId");

-- CreateIndex
CREATE INDEX "Driver_parkId_idx" ON "Driver"("parkId");

-- CreateIndex
CREATE INDEX "Driver_sourceConnectionId_idx" ON "Driver"("sourceConnectionId");

-- CreateIndex
CREATE INDEX "Driver_externalParkId_idx" ON "Driver"("externalParkId");

-- CreateIndex
CREATE INDEX "Driver_externalPersonKey_idx" ON "Driver"("externalPersonKey");

-- CreateIndex
CREATE INDEX "Driver_personResolutionStatus_idx" ON "Driver"("personResolutionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_externalParkId_externalDriverProfileId_key" ON "Driver"("externalParkId", "externalDriverProfileId");

-- AddForeignKey
ALTER TABLE "ParkConnection" ADD CONSTRAINT "ParkConnection_parkId_fkey" FOREIGN KEY ("parkId") REFERENCES "Park"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ParkConnection" ADD CONSTRAINT "ParkConnection_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRawTransportProcessing" ADD CONSTRAINT "MaxRawTransportProcessing_observationId_fkey" FOREIGN KEY ("observationId") REFERENCES "MaxRawTransportEvent"("observationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_account_source_fkey" FOREIGN KEY ("accountId", "sourceObservationId") REFERENCES "MaxRawTransportEvent"("accountId", "observationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_result_account_source_parser_fkey" FOREIGN KEY ("accountId", "normalizationResultId", "sourceObservationId", "parserVersion") REFERENCES "MaxInboundNormalizationResult"("accountId", "normalizationResultId", "sourceObservationId", "parserVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundCommand" ADD CONSTRAINT "MaxOutboundCommand_account_conversation_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundShadowPlan" ADD CONSTRAINT "MaxOutboundShadowPlan_command_fkey" FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence") REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundConversationActor" ADD CONSTRAINT "MaxOutboundConversationActor_account_conversation_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_command_fkey" FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence") REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_actor_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxOutboundConversationActor"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_dispatch_fkey" FOREIGN KEY ("accountId", "conversationKey", "dispatchId") REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_account_conversation_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_command_fkey" FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence") REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_reservation_fkey" FOREIGN KEY ("accountId", "conversationKey", "reservationId", "commandId", "commandSequence") REFERENCES "MaxOutboundCommandReservation"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatchLane" ADD CONSTRAINT "MaxOutboundDispatchLane_account_conversation_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatchAttempt" ADD CONSTRAINT "MaxOutboundDispatchAttempt_dispatch_fkey" FOREIGN KEY ("accountId", "conversationKey", "dispatchId") REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_dispatch_fkey" FOREIGN KEY ("accountId", "conversationKey", "dispatchId") REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_attempt_fkey" FOREIGN KEY ("accountId", "conversationKey", "attemptId") REFERENCES "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_dispatch_fkey" FOREIGN KEY ("accountId", "conversationKey", "dispatchId") REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_attempt_fkey" FOREIGN KEY ("accountId", "conversationKey", "attemptId") REFERENCES "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationEvidence" ADD CONSTRAINT "MaxProviderConfirmationEvidence_account_event_fkey" FOREIGN KEY ("accountId", "sourceNormalizedEventId") REFERENCES "MaxInboundNormalizedEvent"("accountId", "normalizedEventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_evidence_fkey" FOREIGN KEY ("evidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_canonical_evidence_fkey" FOREIGN KEY ("canonicalEvidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_dispatch_fkey" FOREIGN KEY ("dispatchId") REFERENCES "MaxOutboundDispatch"("dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "MaxOutboundDispatchAttempt"("attemptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_transition_fkey" FOREIGN KEY ("transitionId") REFERENCES "MaxOutboundDispatchTransition"("transitionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_resolution_fkey" FOREIGN KEY ("resolutionId") REFERENCES "MaxProviderConfirmationResolution"("resolutionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_evidence_fkey" FOREIGN KEY ("evidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_dispatch_fkey" FOREIGN KEY ("dispatchId") REFERENCES "MaxOutboundDispatch"("dispatchId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_attempt_fkey" FOREIGN KEY ("attemptId") REFERENCES "MaxOutboundDispatchAttempt"("attemptId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_transition_fkey" FOREIGN KEY ("transitionId") REFERENCES "MaxOutboundDispatchTransition"("transitionId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxShadowComparisonResult" ADD CONSTRAINT "MaxShadowComparisonResult_account_run_version_fkey" FOREIGN KEY ("accountId", "runId", "comparisonVersion") REFERENCES "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxShadowComparisonResult" ADD CONSTRAINT "MaxShadowComparisonResult_account_source_fkey" FOREIGN KEY ("accountId", "sourceObservationId") REFERENCES "MaxRawTransportEvent"("accountId", "observationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxShadowSemanticDiff" ADD CONSTRAINT "MaxShadowSemanticDiff_account_result_fkey" FOREIGN KEY ("accountId", "resultId") REFERENCES "MaxShadowComparisonResult"("accountId", "resultId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxShadowComparisonCursor" ADD CONSTRAINT "MaxShadowComparisonCursor_account_run_version_fkey" FOREIGN KEY ("accountId", "runId", "comparisonVersion") REFERENCES "MaxShadowComparisonRun"("accountId", "runId", "comparisonVersion") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_accountId_conversationKey_fkey" FOREIGN KEY ("accountId", "conversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_accountId_candidateConversationKey_fkey" FOREIGN KEY ("accountId", "candidateConversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_accountId_sourceRawObservationId_fkey" FOREIGN KEY ("accountId", "sourceRawObservationId") REFERENCES "MaxRawTransportEvent"("accountId", "observationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_accountId_incumbentConversationKey_fkey" FOREIGN KEY ("accountId", "incumbentConversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_accountId_candidateConversationKey_fkey" FOREIGN KEY ("accountId", "candidateConversationKey") REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_accountId_sourceRouteObservationId_fkey" FOREIGN KEY ("accountId", "sourceRouteObservationId") REFERENCES "MaxRouteObservation"("accountId", "routeObservationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_parkId_fkey" FOREIGN KEY ("parkId") REFERENCES "Park"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "ApiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_mainDriverId_fkey" FOREIGN KEY ("mainDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactDriverProfileAudit" ADD CONSTRAINT "ContactDriverProfileAudit_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraints
-- Prisma cannot express a CHECK constraint, so `migrate diff` does not emit these.

ALTER TABLE "MaxAccountSessionOwner" ADD CONSTRAINT "MaxAccountSessionOwner_fence_version_check" CHECK ((("fencingToken" >= 1) AND (version >= 1)));

ALTER TABLE "MaxAccountSessionOwner" ADD CONSTRAINT "MaxAccountSessionOwner_identity_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" !~ '[[:cntrl:]]'::text) AND ("accountId" <> '*'::text) AND ((char_length("ownerInstanceId") >= 1) AND (char_length("ownerInstanceId") <= 256)) AND ("ownerInstanceId" = btrim("ownerInstanceId")) AND ("ownerInstanceId" !~ '[[:cntrl:]]'::text) AND ("ownerInstanceId" <> '*'::text)));

ALTER TABLE "MaxAccountSessionOwner" ADD CONSTRAINT "MaxAccountSessionOwner_state_time_check" CHECK (((state = ANY (ARRAY['active'::text, 'released'::text])) AND ("heartbeatAt" >= "acquiredAt") AND (((state = 'active'::text) AND ("leaseUntil" > "heartbeatAt")) OR ((state = 'released'::text) AND ("lastReleasedAt" IS NOT NULL) AND ("leaseUntil" = "lastReleasedAt")))));

ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_account_time_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("completedAt" >= "startedAt")));

ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_count_sequence_check" CHECK ((("eventCount" >= 0) AND ("sourceJournalSequence" >= 0)));

ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_issue_check" CHECK (((("issueCode" IS NULL) OR (((char_length("issueCode") >= 1) AND (char_length("issueCode") <= 128)) AND ("issueCode" ~ '^[A-Z0-9_]+$'::text))) AND (("safeIssueSummary" IS NULL) OR ((char_length("safeIssueSummary") >= 1) AND (char_length("safeIssueSummary") <= 512)))));

ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_status_check" CHECK ((status = ANY (ARRAY['normalized'::text, 'unsupported'::text, 'quarantined'::text])));

ALTER TABLE "MaxInboundNormalizationResult" ADD CONSTRAINT "MaxInboundNormalizationResult_versions_check" CHECK ((((char_length("parserVersion") >= 1) AND (char_length("parserVersion") <= 128)) AND ("parserVersion" = btrim("parserVersion")) AND ("parserVersion" !~ '[[:cntrl:]]'::text) AND ((char_length("envelopeVersion") >= 1) AND (char_length("envelopeVersion") <= 128)) AND ("envelopeVersion" = btrim("envelopeVersion")) AND ("envelopeVersion" !~ '[[:cntrl:]]'::text)));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_account_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId"))));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_direction_check" CHECK ((direction = ANY (ARRAY['inbound'::text, 'outbound_echo'::text, 'system'::text, 'unknown'::text])));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_kind_check" CHECK (("eventKind" = ANY (ARRAY['message'::text, 'reaction'::text, 'receipt'::text, 'route_evidence'::text, 'unsupported'::text])));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_ordinal_sequence_check" CHECK ((("eventOrdinal" >= 0) AND ("sourceJournalSequence" >= 0)));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_origin_check" CHECK ((origin = ANY (ARRAY['live'::text, 'history'::text, 'replay'::text, 'unknown'::text])));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_payload_size_check" CHECK ((pg_column_size("normalizedPayload") <= 1048576));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_provider_identifiers_check" CHECK (((("providerMessageId" IS NULL) OR (((char_length("providerMessageId") >= 1) AND (char_length("providerMessageId") <= 512)) AND ("providerMessageId" = btrim("providerMessageId")) AND ("providerMessageId" !~ '[[:cntrl:]]'::text))) AND (("providerUserId" IS NULL) OR (((char_length("providerUserId") >= 1) AND (char_length("providerUserId") <= 512)) AND ("providerUserId" = btrim("providerUserId")) AND ("providerUserId" !~ '[[:cntrl:]]'::text))) AND (("protocolChatId" IS NULL) OR (((char_length("protocolChatId") >= 1) AND (char_length("protocolChatId") <= 512)) AND ("protocolChatId" = btrim("protocolChatId")) AND ("protocolChatId" !~ '[[:cntrl:]]'::text))) AND (("webRouteId" IS NULL) OR (((char_length("webRouteId") >= 1) AND (char_length("webRouteId") <= 512)) AND ("webRouteId" = btrim("webRouteId")) AND ("webRouteId" !~ '[[:cntrl:]]'::text))) AND (("clientMessageId" IS NULL) OR (((char_length("clientMessageId") >= 1) AND (char_length("clientMessageId") <= 512)) AND ("clientMessageId" = btrim("clientMessageId")) AND ("clientMessageId" !~ '[[:cntrl:]]'::text))) AND (("targetProviderMessageId" IS NULL) OR (((char_length("targetProviderMessageId") >= 1) AND (char_length("targetProviderMessageId") <= 512)) AND ("targetProviderMessageId" = btrim("targetProviderMessageId")) AND ("targetProviderMessageId" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxInboundNormalizedEvent" ADD CONSTRAINT "MaxInboundNormalizedEvent_versions_hash_check" CHECK ((((char_length("parserVersion") >= 1) AND (char_length("parserVersion") <= 128)) AND ("parserVersion" = btrim("parserVersion")) AND ("parserVersion" !~ '[[:cntrl:]]'::text) AND ((char_length("envelopeVersion") >= 1) AND (char_length("envelopeVersion") <= 128)) AND ("envelopeVersion" = btrim("envelopeVersion")) AND ("envelopeVersion" !~ '[[:cntrl:]]'::text) AND ("semanticSha256" ~ '^[0-9a-f]{64}$'::text)));

ALTER TABLE "MaxOutboundCommand" ADD CONSTRAINT "MaxOutboundCommand_identity_check" CHECK ((((char_length("commandId") >= 1) AND (char_length("commandId") <= 256)) AND ("commandId" = btrim("commandId")) AND ("commandId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ((char_length("conversationKey") >= 1) AND (char_length("conversationKey") <= 256)) AND ("conversationKey" = btrim("conversationKey")) AND ("conversationKey" !~ '[[:cntrl:]]'::text) AND (("clientMessageId" IS NULL) OR (((char_length("clientMessageId") >= 1) AND (char_length("clientMessageId") <= 256)) AND ("clientMessageId" = btrim("clientMessageId")) AND ("clientMessageId" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxOutboundCommand" ADD CONSTRAINT "MaxOutboundCommand_payload_check" CHECK ((("payloadSha256" ~ '^[0-9a-f]{64}$'::text) AND (pg_column_size("commandPayload") <= 131072) AND (jsonb_typeof("commandPayload") = 'object'::text) AND (("commandPayload" ->> 'kind'::text) = 'text'::text) AND (jsonb_typeof(("commandPayload" -> 'text'::text)) = 'string'::text)));

ALTER TABLE "MaxOutboundCommand" ADD CONSTRAINT "MaxOutboundCommand_sequence_kind_check" CHECK ((("commandSequence" > 0) AND ("commandKind" = 'text'::text) AND ((char_length("envelopeVersion") >= 1) AND (char_length("envelopeVersion") <= 128)) AND ("envelopeVersion" = btrim("envelopeVersion")) AND (source = ANY (ARRAY['gravity'::text, 'api'::text, 'replay'::text, 'synthetic_test'::text]))));

ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_identity_check" CHECK ((((char_length("reservationId") >= 1) AND (char_length("reservationId") <= 256)) AND ("reservationId" = btrim("reservationId")) AND ("reservationId" !~ '[[:cntrl:]]'::text) AND ((char_length("leaseOwnerId") >= 1) AND (char_length("leaseOwnerId") <= 256)) AND ("leaseOwnerId" = btrim("leaseOwnerId")) AND ("leaseOwnerId" !~ '[[:cntrl:]]'::text) AND ("commandSequence" > 0) AND ("leaseEpoch" >= 0) AND ("reservationVersion" >= 0) AND ("leaseUntil" > "reservedAt")));

ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_state_check" CHECK (("reservationState" = ANY (ARRAY['reserved'::text, 'released'::text, 'handed_off'::text, 'expired'::text])));

ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_transition_fields_check" CHECK (((("reservationState" = 'reserved'::text) AND ("releasedAt" IS NULL) AND ("handoffReference" IS NULL) AND ("handedOffAt" IS NULL) AND ("dispatchId" IS NULL)) OR (("reservationState" = ANY (ARRAY['released'::text, 'expired'::text])) AND ("releasedAt" IS NOT NULL) AND ("releasedAt" >= "reservedAt") AND ("handoffReference" IS NULL) AND ("handedOffAt" IS NULL) AND ("dispatchId" IS NULL)) OR (("reservationState" = 'handed_off'::text) AND ("releasedAt" IS NULL) AND ("dispatchId" IS NOT NULL) AND ("handoffReference" = "dispatchId") AND ((char_length("dispatchId") >= 1) AND (char_length("dispatchId") <= 256)) AND ("dispatchId" = btrim("dispatchId")) AND ("dispatchId" !~ '[[:cntrl:]]'::text) AND ("handedOffAt" IS NOT NULL) AND ("handedOffAt" >= "reservedAt"))));

ALTER TABLE "MaxOutboundConversationActor" ADD CONSTRAINT "MaxOutboundConversationActor_lease_version_check" CHECK ((("leaseEpoch" >= 0) AND ("optimisticVersion" >= 0) AND ((("leaseOwnerId" IS NULL) AND ("leaseUntil" IS NULL)) OR (("leaseOwnerId" IS NOT NULL) AND ("leaseUntil" IS NOT NULL) AND ((char_length("leaseOwnerId") >= 1) AND (char_length("leaseOwnerId") <= 256)) AND ("leaseOwnerId" = btrim("leaseOwnerId")) AND ("leaseOwnerId" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxOutboundConversationActor" ADD CONSTRAINT "MaxOutboundConversationActor_sequence_check" CHECK ((("nextCommandSequence" >= 0) AND ("nextHandoffSequence" >= 1) AND ("nextHandoffSequence" <= ("nextCommandSequence" + 1))));

ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_confirmation_check" CHECK ((((("providerMessageId" IS NULL) AND ("providerConfirmedAt" IS NULL)) OR (("providerMessageId" IS NOT NULL) AND ("providerConfirmedAt" IS NOT NULL) AND ((char_length("providerMessageId") >= 1) AND (char_length("providerMessageId") <= 512)) AND ("providerMessageId" = btrim("providerMessageId")) AND ("providerMessageId" !~ '[[:cntrl:]]'::text))) AND ((state = 'provider_confirmed'::text) = ("providerMessageId" IS NOT NULL)) AND ((state = 'reconciliation_required'::text) = ("reconciliationRequiredAt" IS NOT NULL)) AND ((state = ANY (ARRAY['provider_confirmed'::text, 'hard_failed'::text, 'dead_letter'::text])) = ("terminalAt" IS NOT NULL)) AND (("currentAttemptId" IS NULL) OR (((char_length("currentAttemptId") >= 1) AND (char_length("currentAttemptId") <= 256)) AND ("currentAttemptId" = btrim("currentAttemptId")) AND ("currentAttemptId" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_identity_check" CHECK ((((char_length("dispatchId") >= 1) AND (char_length("dispatchId") <= 256)) AND ("dispatchId" = btrim("dispatchId")) AND ("dispatchId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ((char_length("conversationKey") >= 1) AND (char_length("conversationKey") <= 256)) AND ("conversationKey" = btrim("conversationKey")) AND ((char_length("commandId") >= 1) AND (char_length("commandId") <= 256)) AND ("commandId" = btrim("commandId")) AND ("commandSequence" > 0) AND ((char_length("reservationId") >= 1) AND (char_length("reservationId") <= 256)) AND ("reservationId" = btrim("reservationId"))));

ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_initial_route_check" CHECK ((("initialRouteVersion" >= 0) AND ((char_length("initialProtocolChatId") >= 1) AND (char_length("initialProtocolChatId") <= 512)) AND ("initialProtocolChatId" = btrim("initialProtocolChatId")) AND ("initialProtocolChatId" !~ '[[:cntrl:]]'::text) AND (("initialProviderUserId" IS NULL) OR (((char_length("initialProviderUserId") >= 1) AND (char_length("initialProviderUserId") <= 512)) AND ("initialProviderUserId" = btrim("initialProviderUserId")) AND ("initialProviderUserId" !~ '[[:cntrl:]]'::text))) AND (("initialWebRouteId" IS NULL) OR (((char_length("initialWebRouteId") >= 1) AND (char_length("initialWebRouteId") <= 512)) AND ("initialWebRouteId" = btrim("initialWebRouteId")) AND ("initialWebRouteId" !~ '[[:cntrl:]]'::text))) AND (jsonb_typeof("initialRouteEvidence") = 'object'::text) AND (pg_column_size("initialRouteEvidence") <= 65536) AND ("initialRouteSnapshotSha256" ~ '^[0-9a-f]{64}$'::text)));

ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_state_check" CHECK (((state = ANY (ARRAY['queued'::text, 'dispatching'::text, 'sent_to_provider_client'::text, 'awaiting_confirmation'::text, 'reconciliation_required'::text, 'provider_confirmed'::text, 'retryable_failed'::text, 'hard_failed'::text, 'dead_letter'::text])) AND ("stateVersion" >= 1) AND ("attemptCount" >= 0)));

ALTER TABLE "MaxOutboundDispatchAttempt" ADD CONSTRAINT "MaxOutboundDispatchAttempt_identity_version_check" CHECK ((((char_length("attemptId") >= 1) AND (char_length("attemptId") <= 256)) AND ("attemptId" = btrim("attemptId")) AND ("attemptId" !~ '[[:cntrl:]]'::text) AND ((char_length("dispatchId") >= 1) AND (char_length("dispatchId") <= 256)) AND ("dispatchId" = btrim("dispatchId")) AND ("attemptNumber" > 0) AND ("attemptVersion" >= 0) AND ("senderFencingEpoch" >= 0) AND ("routeVersion" >= 0) AND ((char_length("senderOwnerId") >= 1) AND (char_length("senderOwnerId") <= 256)) AND ("senderOwnerId" = btrim("senderOwnerId")) AND ("senderOwnerId" !~ '[[:cntrl:]]'::text) AND ((char_length("attemptCorrelationId") >= 1) AND (char_length("attemptCorrelationId") <= 256)) AND ("attemptCorrelationId" = btrim("attemptCorrelationId")) AND ("attemptCorrelationId" !~ '[[:cntrl:]]'::text) AND ((char_length("protocolChatId") >= 1) AND (char_length("protocolChatId") <= 512)) AND ("protocolChatId" = btrim("protocolChatId")) AND ("protocolChatId" !~ '[[:cntrl:]]'::text) AND (("providerUserId" IS NULL) OR (((char_length("providerUserId") >= 1) AND (char_length("providerUserId") <= 512)) AND ("providerUserId" = btrim("providerUserId")) AND ("providerUserId" !~ '[[:cntrl:]]'::text))) AND (("webRouteId" IS NULL) OR (((char_length("webRouteId") >= 1) AND (char_length("webRouteId") <= 512)) AND ("webRouteId" = btrim("webRouteId")) AND ("webRouteId" !~ '[[:cntrl:]]'::text))) AND ("routeSnapshotSha256" ~ '^[0-9a-f]{64}$'::text) AND ("claimUntil" > "preparedAt")));

ALTER TABLE "MaxOutboundDispatchAttempt" ADD CONSTRAINT "MaxOutboundDispatchAttempt_state_check" CHECK (("attemptState" = ANY (ARRAY['prepared'::text, 'physical_action_started'::text, 'client_action_accepted'::text, 'awaiting_confirmation'::text, 'outcome_unknown'::text, 'provider_confirmed'::text, 'pre_action_failed'::text, 'hard_failed'::text])));

ALTER TABLE "MaxOutboundDispatchAttempt" ADD CONSTRAINT "MaxOutboundDispatchAttempt_timestamps_check" CHECK (((("physicalActionStartedAt" IS NULL) OR ("physicalActionStartedAt" >= "preparedAt")) AND (("clientActionAcceptedAt" IS NULL) OR (("physicalActionStartedAt" IS NOT NULL) AND ("clientActionAcceptedAt" >= "physicalActionStartedAt"))) AND (("awaitingConfirmationAt" IS NULL) OR (("clientActionAcceptedAt" IS NOT NULL) AND ("awaitingConfirmationAt" >= "clientActionAcceptedAt"))) AND (("outcomeUnknownAt" IS NULL) OR ("outcomeUnknownAt" >= "preparedAt")) AND (("completedAt" IS NULL) OR ("completedAt" >= "preparedAt")) AND (("attemptState" = 'prepared'::text) = (("physicalActionStartedAt" IS NULL) AND ("clientActionAcceptedAt" IS NULL) AND ("awaitingConfirmationAt" IS NULL) AND ("outcomeUnknownAt" IS NULL) AND ("completedAt" IS NULL))) AND (("attemptState" <> ALL (ARRAY['physical_action_started'::text, 'client_action_accepted'::text, 'awaiting_confirmation'::text, 'provider_confirmed'::text])) OR ("physicalActionStartedAt" IS NOT NULL)) AND (("attemptState" <> ALL (ARRAY['client_action_accepted'::text, 'awaiting_confirmation'::text])) OR ("clientActionAcceptedAt" IS NOT NULL)) AND (("attemptState" <> 'awaiting_confirmation'::text) OR ("awaitingConfirmationAt" IS NOT NULL)) AND (("attemptState" <> 'outcome_unknown'::text) OR ("outcomeUnknownAt" IS NOT NULL)) AND (("attemptState" <> ALL (ARRAY['provider_confirmed'::text, 'pre_action_failed'::text, 'hard_failed'::text])) OR ("completedAt" IS NOT NULL)) AND (("safeErrorCode" IS NULL) OR (((char_length("safeErrorCode") >= 1) AND (char_length("safeErrorCode") <= 128)) AND ("safeErrorCode" ~ '^[A-Z0-9_]+$'::text)))));

ALTER TABLE "MaxOutboundDispatchLane" ADD CONSTRAINT "MaxOutboundDispatchLane_sequence_version_check" CHECK ((("nextPhysicalSequence" > 0) AND ("optimisticVersion" >= 0)));

ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_identity_check" CHECK ((((char_length("transitionId") >= 1) AND (char_length("transitionId") <= 256)) AND ("transitionId" = btrim("transitionId")) AND ("transitionId" !~ '[[:cntrl:]]'::text) AND ((char_length("transitionIdempotencyKey") >= 1) AND (char_length("transitionIdempotencyKey") <= 256)) AND ("transitionIdempotencyKey" = btrim("transitionIdempotencyKey")) AND ("transitionIdempotencyKey" !~ '[[:cntrl:]]'::text) AND ("transitionSequence" > 0) AND ("stateVersionBefore" >= 0) AND ("stateVersionAfter" = ("stateVersionBefore" + 1)) AND ("evidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof("safeEvidenceMetadata") = 'object'::text) AND (pg_column_size("safeEvidenceMetadata") <= 32768) AND (("evidenceReference" IS NULL) OR (((char_length("evidenceReference") >= 1) AND (char_length("evidenceReference") <= 512)) AND ("evidenceReference" = btrim("evidenceReference")) AND ("evidenceReference" !~ '[[:cntrl:]]'::text) AND ("evidenceReference" !~* '^(https?|wss?)://'::text)))));

ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_state_check" CHECK (((("fromState" IS NULL) OR ("fromState" = ANY (ARRAY['queued'::text, 'dispatching'::text, 'sent_to_provider_client'::text, 'awaiting_confirmation'::text, 'reconciliation_required'::text, 'provider_confirmed'::text, 'retryable_failed'::text, 'hard_failed'::text, 'dead_letter'::text]))) AND ("toState" = ANY (ARRAY['queued'::text, 'dispatching'::text, 'sent_to_provider_client'::text, 'awaiting_confirmation'::text, 'reconciliation_required'::text, 'provider_confirmed'::text, 'retryable_failed'::text, 'hard_failed'::text, 'dead_letter'::text])) AND ((char_length("eventType") >= 1) AND (char_length("eventType") <= 128)) AND ("eventType" ~ '^[a-z0-9_]+$'::text) AND ("evidenceKind" = ANY (ARRAY['dispatch_creation'::text, 'sender_authority'::text, 'physical_marker'::text, 'client_ack'::text, 'awaiting_confirmation'::text, 'unknown_outcome'::text, 'exact_provider_confirmation'::text, 'provider_absence'::text, 'retry_policy'::text, 'contract_failure'::text, 'dead_letter_policy'::text, 'terminal_skip'::text, 'recovery'::text]))));

ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_identity_version_check" CHECK ((((char_length("reconciliationId") >= 1) AND (char_length("reconciliationId") <= 256)) AND ("reconciliationId" = btrim("reconciliationId")) AND ("reconciliationId" !~ '[[:cntrl:]]'::text) AND ("taskVersion" >= 0) AND (reason = ANY (ARRAY['outcome_unknown'::text, 'timeout'::text, 'restart_post_action'::text, 'restart_client_accepted'::text, 'restart_awaiting_confirmation'::text])) AND (("notBefore" IS NULL) OR ("notBefore" >= "openedAt"))));

ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_state_check" CHECK (((state = ANY (ARRAY['open'::text, 'resolved'::text, 'dead_letter'::text])) AND (((state = 'open'::text) AND ("resolvedAt" IS NULL) AND ("resolutionType" IS NULL) AND ("resolutionEvidenceReference" IS NULL)) OR ((state = ANY (ARRAY['resolved'::text, 'dead_letter'::text])) AND ("resolvedAt" IS NOT NULL) AND ("resolvedAt" >= "openedAt") AND ("resolutionType" = ANY (ARRAY['exact_provider_confirmation'::text, 'provider_absence_proven'::text, 'operator_dead_letter'::text])) AND ("resolutionEvidenceReference" IS NOT NULL) AND ((char_length("resolutionEvidenceReference") >= 1) AND (char_length("resolutionEvidenceReference") <= 512)) AND ("resolutionEvidenceReference" = btrim("resolutionEvidenceReference")) AND ("resolutionEvidenceReference" !~ '[[:cntrl:]]'::text) AND ("resolutionEvidenceReference" !~* '^(https?|wss?)://'::text)))));

ALTER TABLE "MaxOutboundShadowPlan" ADD CONSTRAINT "MaxOutboundShadowPlan_decision_check" CHECK ((((char_length("payloadKind") >= 1) AND (char_length("payloadKind") <= 64)) AND ("replyMetadata" = 'none'::text) AND ((("wouldSend" = true) AND ("refusalReason" IS NULL)) OR (("wouldSend" = false) AND ("refusalReason" = ANY (ARRAY['ROUTE_NOT_FOUND'::text, 'ROUTE_CONFLICT'::text, 'ACCOUNT_MISMATCH'::text, 'CONVERSATION_NOT_SENDABLE'::text, 'OWNER_NOT_ACQUIRED'::text, 'OWNER_LEASE_EXPIRED'::text, 'FENCING_TOKEN_MISSING'::text, 'FENCING_TOKEN_STALE'::text, 'PAYLOAD_UNSUPPORTED'::text, 'COMMAND_ALREADY_TERMINAL'::text, 'IDEMPOTENCY_CONFLICT'::text])))) AND (jsonb_typeof("semanticComparison") = 'object'::text)));

ALTER TABLE "MaxOutboundShadowPlan" ADD CONSTRAINT "MaxOutboundShadowPlan_hash_sequence_check" CHECK ((("inputSha256" ~ '^[0-9a-f]{64}$'::text) AND ("accountAliasSha256" ~ '^[0-9a-f]{64}$'::text) AND ("conversationKeySha256" ~ '^[0-9a-f]{64}$'::text) AND ("payloadSha256" ~ '^[0-9a-f]{64}$'::text) AND ("commandSequence" > 0) AND (("payloadSizeBytes" >= 0) AND ("payloadSizeBytes" <= 65536)) AND (("routeVersion" IS NULL) OR ("routeVersion" >= 0)) AND (("ownerFencingToken" IS NULL) OR ("ownerFencingToken" >= 1))));

ALTER TABLE "MaxOutboundShadowPlan" ADD CONSTRAINT "MaxOutboundShadowPlan_identity_check" CHECK ((((char_length("planId") >= 1) AND (char_length("planId") <= 256)) AND ("planId" = btrim("planId")) AND ("planId" !~ '[[:cntrl:]]'::text) AND ((char_length("schemaVersion") >= 1) AND (char_length("schemaVersion") <= 128)) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" <> '*'::text) AND ((char_length("conversationKey") >= 1) AND (char_length("conversationKey") <= 256)) AND ("conversationKey" = btrim("conversationKey")) AND ((char_length("reservationId") >= 1) AND (char_length("reservationId") <= 256)) AND ("reservationId" = btrim("reservationId")) AND ((char_length("attemptCorrelationId") >= 1) AND (char_length("attemptCorrelationId") <= 256)) AND ("attemptCorrelationId" = btrim("attemptCorrelationId")) AND ((char_length("idempotencyKey") >= 1) AND (char_length("idempotencyKey") <= 256)) AND ("idempotencyKey" = btrim("idempotencyKey"))));

ALTER TABLE "MaxProviderConfirmationCursor" ADD CONSTRAINT "MaxProviderConfirmationCursor_value_check" CHECK ((((char_length("cursorId") >= 1) AND (char_length("cursorId") <= 256)) AND ("cursorId" = btrim("cursorId")) AND ((char_length("consumerId") >= 1) AND (char_length("consumerId") <= 256)) AND ("consumerId" = btrim("consumerId")) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ((char_length("matcherVersion") >= 1) AND (char_length("matcherVersion") <= 128)) AND ("matcherVersion" = btrim("matcherVersion")) AND ("lastJournalSequence" >= 0) AND ("lastEventOrdinal" >= 0) AND ("optimisticVersion" >= 0)));

ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_identity_check" CHECK ((((char_length("decisionId") >= 1) AND (char_length("decisionId") <= 256)) AND ("decisionId" = btrim("decisionId")) AND ("decisionId" !~ '[[:cntrl:]]'::text) AND ((char_length("resolutionId") >= 1) AND (char_length("resolutionId") <= 256)) AND ("resolutionId" = btrim("resolutionId")) AND ((char_length("evidenceId") >= 1) AND (char_length("evidenceId") <= 256)) AND ("evidenceId" = btrim("evidenceId")) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("decisionSequence" > 0) AND ((char_length("matcherVersion") >= 1) AND (char_length("matcherVersion") <= 128)) AND ("matcherVersion" = btrim("matcherVersion")) AND ((char_length("decisionType") >= 1) AND (char_length("decisionType") <= 128)) AND ("decisionType" ~ '^[a-z0-9_]+$'::text) AND ((char_length(actor) >= 1) AND (char_length(actor) <= 256)) AND (actor = btrim(actor)) AND (actor !~ '[[:cntrl:]]'::text) AND ((char_length(reason) >= 1) AND (char_length(reason) <= 512)) AND (reason = btrim(reason)) AND (reason !~ '[[:cntrl:]]'::text) AND ("decisionSha256" ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof("safeMetadata") = 'object'::text) AND (pg_column_size("safeMetadata") <= 16384)));

ALTER TABLE "MaxProviderConfirmationDecision" ADD CONSTRAINT "MaxProviderConfirmationDecision_state_check" CHECK (((("fromStatus" IS NULL) OR ("fromStatus" = ANY (ARRAY['pending'::text, 'deferred'::text, 'matched'::text, 'duplicate'::text, 'unmatched'::text, 'ambiguous'::text, 'ignored'::text, 'quarantined'::text]))) AND ("toStatus" = ANY (ARRAY['pending'::text, 'deferred'::text, 'matched'::text, 'duplicate'::text, 'unmatched'::text, 'ambiguous'::text, 'ignored'::text, 'quarantined'::text])) AND ("resolutionVersionBefore" >= 0) AND ("resolutionVersionAfter" >= "resolutionVersionBefore") AND ("decisionSequence" = ("resolutionVersionAfter" + 1)) AND ((("fromStatus" IS NULL) AND ("resolutionVersionBefore" = 0) AND ("resolutionVersionAfter" = 0)) OR (("fromStatus" IS NOT NULL) AND ("resolutionVersionAfter" = ("resolutionVersionBefore" + 1)))) AND (("transitionId" IS NULL) OR (("dispatchId" IS NOT NULL) AND ("attemptId" IS NOT NULL)))));

ALTER TABLE "MaxProviderConfirmationEvidence" ADD CONSTRAINT "MaxProviderConfirmationEvidence_exact_fields_check" CHECK (((("providerMessageId" IS NULL) OR (((char_length("providerMessageId") >= 1) AND (char_length("providerMessageId") <= 512)) AND ("providerMessageId" = btrim("providerMessageId")) AND ("providerMessageId" !~ '[[:cntrl:]]'::text))) AND (("attemptCorrelationId" IS NULL) OR (((char_length("attemptCorrelationId") >= 1) AND (char_length("attemptCorrelationId") <= 256)) AND ("attemptCorrelationId" = btrim("attemptCorrelationId")) AND ("attemptCorrelationId" !~ '[[:cntrl:]]'::text))) AND (("clientMessageId" IS NULL) OR (((char_length("clientMessageId") >= 1) AND (char_length("clientMessageId") <= 256)) AND ("clientMessageId" = btrim("clientMessageId")) AND ("clientMessageId" !~ '[[:cntrl:]]'::text))) AND (("protocolChatId" IS NULL) OR (((char_length("protocolChatId") >= 1) AND (char_length("protocolChatId") <= 512)) AND ("protocolChatId" = btrim("protocolChatId")) AND ("protocolChatId" !~ '[[:cntrl:]]'::text))) AND (("providerUserId" IS NULL) OR (((char_length("providerUserId") >= 1) AND (char_length("providerUserId") <= 512)) AND ("providerUserId" = btrim("providerUserId")) AND ("providerUserId" !~ '[[:cntrl:]]'::text))) AND (("webRouteId" IS NULL) OR (((char_length("webRouteId") >= 1) AND (char_length("webRouteId") <= 512)) AND ("webRouteId" = btrim("webRouteId")) AND ("webRouteId" !~ '[[:cntrl:]]'::text))) AND ("evidenceSha256" ~ '^[0-9a-f]{64}$'::text) AND (jsonb_typeof("safeMetadata") = 'object'::text) AND (pg_column_size("safeMetadata") <= 16384)));

ALTER TABLE "MaxProviderConfirmationEvidence" ADD CONSTRAINT "MaxProviderConfirmationEvidence_identity_check" CHECK ((((char_length("evidenceId") >= 1) AND (char_length("evidenceId") <= 256)) AND ("evidenceId" = btrim("evidenceId")) AND ("evidenceId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ((char_length("sourceNormalizedEventId") >= 1) AND (char_length("sourceNormalizedEventId") <= 256)) AND ("sourceNormalizedEventId" = btrim("sourceNormalizedEventId")) AND ((char_length("sourceObservationId") >= 1) AND (char_length("sourceObservationId") <= 256)) AND ("sourceObservationId" = btrim("sourceObservationId")) AND ("sourceJournalSequence" >= 0) AND ("sourceEventOrdinal" >= 0) AND ((char_length("matcherVersion") >= 1) AND (char_length("matcherVersion") <= 128)) AND ("matcherVersion" = btrim("matcherVersion")) AND ((char_length("evidenceVersion") >= 1) AND (char_length("evidenceVersion") <= 128)) AND ("evidenceVersion" = btrim("evidenceVersion"))));

ALTER TABLE "MaxProviderConfirmationEvidence" ADD CONSTRAINT "MaxProviderConfirmationEvidence_kind_check" CHECK (("evidenceKind" = ANY (ARRAY['outbound_echo'::text, 'provider_acceptance_receipt'::text, 'recipient_delivery_receipt'::text, 'recipient_read_receipt'::text, 'provider_absence'::text, 'unknown_receipt'::text, 'unsupported'::text])));

ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_identity_check" CHECK ((((char_length("resolutionId") >= 1) AND (char_length("resolutionId") <= 256)) AND ("resolutionId" = btrim("resolutionId")) AND ("resolutionId" !~ '[[:cntrl:]]'::text) AND ((char_length("evidenceId") >= 1) AND (char_length("evidenceId") <= 256)) AND ("evidenceId" = btrim("evidenceId")) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ((char_length("matcherVersion") >= 1) AND (char_length("matcherVersion") <= 128)) AND ("matcherVersion" = btrim("matcherVersion")) AND ("resolutionVersion" >= 0) AND ("retryCount" >= 0)));

ALTER TABLE "MaxProviderConfirmationResolution" ADD CONSTRAINT "MaxProviderConfirmationResolution_state_check" CHECK (((status = ANY (ARRAY['pending'::text, 'deferred'::text, 'matched'::text, 'duplicate'::text, 'unmatched'::text, 'ambiguous'::text, 'ignored'::text, 'quarantined'::text])) AND ("matchMethod" = ANY (ARRAY['attempt_correlation_id'::text, 'client_message_id'::text, 'existing_provider_message_id'::text, 'provider_absence_reference'::text, 'none'::text])) AND (jsonb_typeof("candidateDispatchIds") = 'array'::text) AND (jsonb_typeof("candidateAttemptIds") = 'array'::text) AND (jsonb_array_length("candidateDispatchIds") <= 64) AND (jsonb_array_length("candidateAttemptIds") <= 64) AND (("issueCode" IS NULL) OR ("issueCode" ~ '^[A-Z0-9_]{1,128}$'::text)) AND (("safeIssueSummary" IS NULL) OR (((char_length("safeIssueSummary") >= 1) AND (char_length("safeIssueSummary") <= 512)) AND ("safeIssueSummary" !~ '[[:cntrl:]]'::text))) AND ((status = ANY (ARRAY['pending'::text, 'deferred'::text, 'ambiguous'::text])) OR ("resolvedAt" IS NOT NULL)) AND ((status = 'deferred'::text) = ("nextRetryAt" IS NOT NULL)) AND ((status <> ALL (ARRAY['matched'::text, 'duplicate'::text])) OR (("dispatchId" IS NOT NULL) AND ("attemptId" IS NOT NULL))) AND ((status <> 'matched'::text) OR ("transitionId" IS NOT NULL)) AND ((status <> 'duplicate'::text) OR ("canonicalEvidenceId" IS NOT NULL)) AND ((status <> ALL (ARRAY['pending'::text, 'deferred'::text, 'unmatched'::text, 'ambiguous'::text, 'ignored'::text, 'quarantined'::text])) OR ("transitionId" IS NULL)) AND (("resolvedBy" IS NULL) OR (((char_length("resolvedBy") >= 1) AND (char_length("resolvedBy") <= 256)) AND ("resolvedBy" = btrim("resolvedBy")) AND ("resolvedBy" !~ '[[:cntrl:]]'::text))) AND (("resolutionReason" IS NULL) OR (((char_length("resolutionReason") >= 1) AND (char_length("resolutionReason") <= 512)) AND ("resolutionReason" = btrim("resolutionReason")) AND ("resolutionReason" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxRawTransportCursor" ADD CONSTRAINT "MaxRawTransportCursor_positionVersion_check" CHECK ((("lastJournalSequence" >= 0) AND (version >= 0)));

ALTER TABLE "MaxRawTransportEvent" ADD CONSTRAINT "MaxRawTransportEvent_payloadSizeBytes_check" CHECK (("payloadSizeBytes" >= 0));

ALTER TABLE "MaxRawTransportEvent" ADD CONSTRAINT "MaxRawTransportEvent_quarantineConsistency_check" CHECK (((("replayAvailability" = 'available'::text) AND ("quarantineReason" IS NULL)) OR (("replayAvailability" = 'quarantined'::text) AND ("quarantineReason" IS NOT NULL))));

ALTER TABLE "MaxRawTransportEvent" ADD CONSTRAINT "MaxRawTransportEvent_replayAvailability_check" CHECK (("replayAvailability" = ANY (ARRAY['available'::text, 'quarantined'::text])));

ALTER TABLE "MaxRawTransportProcessing" ADD CONSTRAINT "MaxRawTransportProcessing_state_check" CHECK ((state = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'retryable'::text, 'quarantined'::text, 'dead_letter'::text])));

ALTER TABLE "MaxRawTransportProcessing" ADD CONSTRAINT "MaxRawTransportProcessing_versions_check" CHECK (((attempts >= 0) AND ("leaseVersion" >= 0)));

ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_account_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId"))));

ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_kind_check" CHECK (("identityKind" = ANY (ARRAY['provider_user_id'::text, 'protocol_chat_id'::text, 'web_route_id'::text])));

ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_resolution_audit_check" CHECK ((((status = 'open'::text) AND ("resolvedAt" IS NULL) AND ("resolutionReason" IS NULL) AND ("resolvedBy" IS NULL) AND ("auditMetadata" IS NULL)) OR ((status = ANY (ARRAY['resolved'::text, 'dismissed'::text])) AND ("resolvedAt" IS NOT NULL) AND (char_length("resolutionReason") > 0) AND (char_length("resolvedBy") > 0) AND ("auditMetadata" IS NOT NULL))));

ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_status_check" CHECK ((status = ANY (ARRAY['open'::text, 'resolved'::text, 'dismissed'::text])));

ALTER TABLE "MaxRouteConflict" ADD CONSTRAINT "MaxRouteConflict_versions_check" CHECK ((("expectedRouteVersion" >= 0) AND (version >= 0)));

ALTER TABLE "MaxRouteConversation" ADD CONSTRAINT "MaxRouteConversation_account_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId"))));

ALTER TABLE "MaxRouteConversation" ADD CONSTRAINT "MaxRouteConversation_key_check" CHECK ((((char_length("conversationKey") >= 1) AND (char_length("conversationKey") <= 256)) AND ("conversationKey" = btrim("conversationKey")) AND ("conversationKey" !~ '[[:cntrl:]]'::text)));

ALTER TABLE "MaxRouteConversation" ADD CONSTRAINT "MaxRouteConversation_retirement_audit_check" CHECK ((((state <> 'retired'::text) AND ("retiredAt" IS NULL) AND ("retiredBy" IS NULL) AND ("retirementReason" IS NULL)) OR ((state = 'retired'::text) AND ("retiredAt" IS NOT NULL) AND (char_length("retiredBy") > 0) AND (char_length("retirementReason") > 0))));

ALTER TABLE "MaxRouteConversation" ADD CONSTRAINT "MaxRouteConversation_state_check" CHECK ((state = ANY (ARRAY['unresolved'::text, 'active'::text, 'conflicted'::text, 'retired'::text])));

ALTER TABLE "MaxRouteConversation" ADD CONSTRAINT "MaxRouteConversation_versions_check" CHECK ((("routeVersion" >= 0) AND ("optimisticVersion" >= 0)));

ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_account_time_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("lastSeenAt" >= "firstSeenAt")));

ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_kind_check" CHECK (("identityKind" = ANY (ARRAY['provider_user_id'::text, 'protocol_chat_id'::text, 'web_route_id'::text])));

ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_status_check" CHECK ((status = ANY (ARRAY['provisional'::text, 'active'::text, 'superseded'::text, 'conflicted'::text])));

ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_value_check" CHECK ((((char_length("identityValue") >= 1) AND (char_length("identityValue") <= 512)) AND ("identityValue" = btrim("identityValue")) AND ("identityValue" !~ '[[:cntrl:]]'::text)));

ALTER TABLE "MaxRouteIdentityBinding" ADD CONSTRAINT "MaxRouteIdentityBinding_version_check" CHECK ((version >= 0));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_account_hash_check" CHECK ((((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("idempotencyKey" ~ '^[0-9a-f]{64}$'::text) AND ("evidenceSha256" ~ '^[0-9a-f]{64}$'::text)));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_authority_check" CHECK (("evidenceAuthority" = ANY (ARRAY['protocol_exact'::text, 'provider_exact'::text, 'web_route_observed'::text, 'legacy_import'::text, 'manual_approved'::text])));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_identity_value_check" CHECK ((((char_length("identityValue") >= 1) AND (char_length("identityValue") <= 512)) AND ("identityValue" = btrim("identityValue")) AND ("identityValue" !~ '[[:cntrl:]]'::text)));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_kind_check" CHECK (("identityKind" = ANY (ARRAY['provider_user_id'::text, 'protocol_chat_id'::text, 'web_route_id'::text])));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_result_check" CHECK (("processingResult" = ANY (ARRAY['created'::text, 'confirmed'::text, 'attached'::text, 'provisional'::text, 'conflict'::text, 'requires_supersede'::text, 'ignored_weak'::text, 'superseded'::text, 'retired'::text])));

ALTER TABLE "MaxRouteObservation" ADD CONSTRAINT "MaxRouteObservation_size_version_check" CHECK ((("evidenceSizeBytes" >= 0) AND (("routeVersionAfter" IS NULL) OR ("routeVersionAfter" >= 0))));

ALTER TABLE "MaxShadowComparisonCursor" ADD CONSTRAINT "MaxShadowComparisonCursor_value_check" CHECK ((((char_length("cursorId") >= 1) AND (char_length("cursorId") <= 256)) AND ("cursorId" = btrim("cursorId")) AND ("cursorId" !~ '[[:cntrl:]]'::text) AND ((char_length("runId") >= 1) AND (char_length("runId") <= 256)) AND ("runId" = btrim("runId")) AND ("runId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" !~ '[[:cntrl:]]'::text) AND ((char_length("comparisonVersion") >= 1) AND (char_length("comparisonVersion") <= 128)) AND ("comparisonVersion" = btrim("comparisonVersion")) AND ("lastJournalSequence" >= 0) AND ("optimisticVersion" >= 0)));

ALTER TABLE "MaxShadowComparisonResult" ADD CONSTRAINT "MaxShadowComparisonResult_identity_check" CHECK ((((char_length("resultId") >= 1) AND (char_length("resultId") <= 256)) AND ("resultId" = btrim("resultId")) AND ("resultId" !~ '[[:cntrl:]]'::text) AND ((char_length("runId") >= 1) AND (char_length("runId") <= 256)) AND ("runId" = btrim("runId")) AND ("runId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" !~ '[[:cntrl:]]'::text) AND ((char_length("sourceObservationId") >= 1) AND (char_length("sourceObservationId") <= 256)) AND ("sourceObservationId" = btrim("sourceObservationId")) AND ("sourceJournalSequence" >= 0) AND ((char_length("comparisonVersion") >= 1) AND (char_length("comparisonVersion") <= 128)) AND ("comparisonVersion" = btrim("comparisonVersion"))));

ALTER TABLE "MaxShadowComparisonResult" ADD CONSTRAINT "MaxShadowComparisonResult_semantic_check" CHECK (((classification = ANY (ARRAY['matched'::text, 'expected_difference'::text, 'regression'::text, 'legacy_only'::text, 'new_only'::text, 'unsupported'::text, 'quarantined'::text])) AND ("legacyStatus" = ANY (ARRAY['normalized'::text, 'unsupported'::text, 'quarantined'::text, 'absent'::text])) AND ("newStatus" = ANY (ARRAY['normalized'::text, 'unsupported'::text, 'quarantined'::text, 'absent'::text])) AND ("legacySemanticSha256" ~ '^[0-9a-f]{64}$'::text) AND ("newSemanticSha256" ~ '^[0-9a-f]{64}$'::text) AND ("diffCount" >= 0) AND ("diffCount" <= 4096) AND ("highestSeverity" = ANY (ARRAY['none'::text, 'info'::text, 'warning'::text, 'error'::text, 'critical'::text])) AND ((("diffCount" = 0) AND ("highestSeverity" = 'none'::text)) OR (("diffCount" > 0) AND ("highestSeverity" <> 'none'::text))) AND (("issueCode" IS NULL) OR ("issueCode" ~ '^[A-Z0-9_]{1,128}$'::text)) AND (("safeSummary" IS NULL) OR (((char_length("safeSummary") >= 1) AND (char_length("safeSummary") <= 512)) AND ("safeSummary" !~ '[[:cntrl:]]'::text)))));

ALTER TABLE "MaxShadowComparisonRun" ADD CONSTRAINT "MaxShadowComparisonRun_counter_check" CHECK ((("processedCount" >= 0) AND ("matchedCount" >= 0) AND ("expectedDifferenceCount" >= 0) AND ("regressionCount" >= 0) AND ("legacyOnlyCount" >= 0) AND ("newOnlyCount" >= 0) AND ("unsupportedCount" >= 0) AND ("quarantinedCount" >= 0) AND ("processedCount" = (((((("matchedCount" + "expectedDifferenceCount") + "regressionCount") + "legacyOnlyCount") + "newOnlyCount") + "unsupportedCount") + "quarantinedCount"))));

ALTER TABLE "MaxShadowComparisonRun" ADD CONSTRAINT "MaxShadowComparisonRun_identity_check" CHECK ((((char_length("runId") >= 1) AND (char_length("runId") <= 256)) AND ("runId" = btrim("runId")) AND ("runId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" !~ '[[:cntrl:]]'::text) AND ((char_length("comparisonVersion") >= 1) AND (char_length("comparisonVersion") <= 128)) AND ("comparisonVersion" = btrim("comparisonVersion")) AND ((char_length("legacyAdapterVersion") >= 1) AND (char_length("legacyAdapterVersion") <= 128)) AND ("legacyAdapterVersion" = btrim("legacyAdapterVersion")) AND ((char_length("newNormalizerVersion") >= 1) AND (char_length("newNormalizerVersion") <= 128)) AND ("newNormalizerVersion" = btrim("newNormalizerVersion"))));

ALTER TABLE "MaxShadowComparisonRun" ADD CONSTRAINT "MaxShadowComparisonRun_range_check" CHECK (((("sourceFromJournalSequence" IS NULL) OR ("sourceFromJournalSequence" >= 0)) AND (("sourceToJournalSequence" IS NULL) OR ("sourceToJournalSequence" >= 0)) AND (("sourceFromJournalSequence" IS NULL) OR ("sourceToJournalSequence" IS NULL) OR ("sourceToJournalSequence" >= "sourceFromJournalSequence"))));

ALTER TABLE "MaxShadowComparisonRun" ADD CONSTRAINT "MaxShadowComparisonRun_state_check" CHECK (((state = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])) AND (((state = 'running'::text) AND ("completedAt" IS NULL)) OR ((state <> 'running'::text) AND ("completedAt" IS NOT NULL)))));

ALTER TABLE "MaxShadowSemanticDiff" ADD CONSTRAINT "MaxShadowSemanticDiff_identity_check" CHECK ((((char_length("diffId") >= 1) AND (char_length("diffId") <= 256)) AND ("diffId" = btrim("diffId")) AND ("diffId" !~ '[[:cntrl:]]'::text) AND ((char_length("resultId") >= 1) AND (char_length("resultId") <= 256)) AND ("resultId" = btrim("resultId")) AND ("resultId" !~ '[[:cntrl:]]'::text) AND ((char_length("accountId") >= 1) AND (char_length("accountId") <= 128)) AND ("accountId" = btrim("accountId")) AND ("accountId" !~ '[[:cntrl:]]'::text) AND ("diffOrdinal" >= 0) AND ("diffOrdinal" < 4096) AND ((char_length(path) >= 1) AND (char_length(path) <= 512)) AND (path ~~ '$%'::text) AND (path !~ '[[:cntrl:]]'::text)));

ALTER TABLE "MaxShadowSemanticDiff" ADD CONSTRAINT "MaxShadowSemanticDiff_policy_check" CHECK ((("differenceKind" = ANY (ARRAY['missing_event'::text, 'extra_event'::text, 'kind_mismatch'::text, 'direction_mismatch'::text, 'origin_mismatch'::text, 'identifier_mismatch'::text, 'timestamp_mismatch'::text, 'text_hash_mismatch'::text, 'caption_hash_mismatch'::text, 'attachment_count_mismatch'::text, 'attachment_identity_mismatch'::text, 'media_kind_mismatch'::text, 'reply_target_mismatch'::text, 'reaction_target_mismatch'::text, 'receipt_semantic_mismatch'::text, 'route_evidence_mismatch'::text, 'classification_mismatch'::text])) AND (severity = ANY (ARRAY['info'::text, 'warning'::text, 'error'::text, 'critical'::text])) AND ("legacyValueType" = ANY (ARRAY['missing'::text, 'null'::text, 'string'::text, 'number'::text, 'boolean'::text, 'array'::text, 'object'::text])) AND ("newValueType" = ANY (ARRAY['missing'::text, 'null'::text, 'string'::text, 'number'::text, 'boolean'::text, 'array'::text, 'object'::text])) AND (("legacyValueHash" IS NULL) OR ("legacyValueHash" ~ '^[0-9a-f]{64}$'::text)) AND (("newValueHash" IS NULL) OR ("newValueHash" ~ '^[0-9a-f]{64}$'::text)) AND (jsonb_typeof("safeMetadata") = 'object'::text) AND (pg_column_size("safeMetadata") <= 8192)));


-- PartialUniqueIndexes
-- Prisma cannot express a partial index. These carry real invariants: one active
-- reservation per conversation, one open conflict per identity route pair, one open
-- reconciliation task per dispatch.

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_active_command_key" ON "MaxOutboundCommandReservation" USING btree ("accountId", "conversationKey", "commandId") WHERE ("reservationState" = 'reserved'::text);

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_active_conversation_key" ON "MaxOutboundCommandReservation" USING btree ("accountId", "conversationKey") WHERE ("reservationState" = 'reserved'::text);

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_partial_key" ON "MaxOutboundCommandReservation" USING btree ("accountId", "dispatchId") WHERE ("dispatchId" IS NOT NULL);

CREATE UNIQUE INDEX "MaxOutboundCommand_account_client_message_key" ON "MaxOutboundCommand" USING btree ("accountId", "clientMessageId") WHERE ("clientMessageId" IS NOT NULL);

CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_active_dispatch_key" ON "MaxOutboundDispatchAttempt" USING btree ("dispatchId") WHERE ("completedAt" IS NULL);

CREATE UNIQUE INDEX "MaxOutboundDispatch_account_provider_message_key" ON "MaxOutboundDispatch" USING btree ("accountId", "providerMessageId") WHERE ("providerMessageId" IS NOT NULL);

CREATE UNIQUE INDEX "MaxOutboundReconciliationTask_open_dispatch_key" ON "MaxOutboundReconciliationTask" USING btree ("dispatchId") WHERE (state = 'open'::text);

CREATE UNIQUE INDEX "MaxRawTransportEvent_accountId_captureEnvelopeId_key" ON "MaxRawTransportEvent" USING btree ("accountId", "captureEnvelopeId") WHERE ("captureEnvelopeId" IS NOT NULL);

CREATE UNIQUE INDEX "MaxRouteConflict_one_open_identity_route_pair_key" ON "MaxRouteConflict" USING btree ("accountId", "identityKind", "identityValue", "incumbentConversationKey", "candidateConversationKey") WHERE (status = 'open'::text);

CREATE UNIQUE INDEX "MaxRouteIdentityBinding_one_active_kind_per_conversation_key" ON "MaxRouteIdentityBinding" USING btree ("accountId", "conversationKey", "identityKind") WHERE (status = 'active'::text);


-- GuardFunctions
-- Append-only, immutability, fencing-token and cursor-monotonicity guards.

CREATE FUNCTION max_account_session_owner_fence_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner rows cannot be deleted because fencing tokens are durable';
    END IF;
    IF NEW."accountId" <> OLD."accountId" THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner accountId is immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner version must increment exactly once';
    END IF;
    IF NEW."fencingToken" < OLD."fencingToken" OR NEW."fencingToken" > OLD."fencingToken" + 1 THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner fencing token must be monotonic and contiguous';
    END IF;
    IF NEW."fencingToken" = OLD."fencingToken" THEN
        IF NEW."ownerInstanceId" <> OLD."ownerInstanceId" OR NEW."acquiredAt" <> OLD."acquiredAt" THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner owner cannot change without a new fencing token';
        END IF;
        IF OLD."state" = 'released' AND NEW."state" = 'active' THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner released fencing token cannot be revived';
        END IF;
    ELSE
        IF NEW."state" <> 'active' OR NEW."acquiredAt" < OLD."acquiredAt" THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner takeover must create a newer active fence';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_inbound_normalization_result_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxInboundNormalizationResult is append-only';
END;
$function$;

CREATE FUNCTION max_inbound_normalized_event_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxInboundNormalizedEvent is append-only';
END;
$function$;

CREATE FUNCTION max_outbound_command_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxOutboundCommand is append-only';
END;
$function$;

CREATE FUNCTION max_outbound_dispatch_attempt_immutable_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."attemptId" IS DISTINCT FROM OLD."attemptId"
       OR NEW."dispatchId" IS DISTINCT FROM OLD."dispatchId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."conversationKey" IS DISTINCT FROM OLD."conversationKey"
       OR NEW."attemptNumber" IS DISTINCT FROM OLD."attemptNumber"
       OR NEW."senderOwnerId" IS DISTINCT FROM OLD."senderOwnerId"
       OR NEW."senderFencingEpoch" IS DISTINCT FROM OLD."senderFencingEpoch"
       OR NEW."senderAuthorityVerifiedAt" IS DISTINCT FROM OLD."senderAuthorityVerifiedAt"
       OR NEW."attemptCorrelationId" IS DISTINCT FROM OLD."attemptCorrelationId"
       OR NEW."routeVersion" IS DISTINCT FROM OLD."routeVersion"
       OR NEW."protocolChatId" IS DISTINCT FROM OLD."protocolChatId"
       OR NEW."providerUserId" IS DISTINCT FROM OLD."providerUserId"
       OR NEW."webRouteId" IS DISTINCT FROM OLD."webRouteId"
       OR NEW."routeSnapshotSha256" IS DISTINCT FROM OLD."routeSnapshotSha256"
       OR NEW."preparedAt" IS DISTINCT FROM OLD."preparedAt"
       OR NEW."claimUntil" IS DISTINCT FROM OLD."claimUntil"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxOutboundDispatchAttempt immutable authority or route mutation rejected';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_outbound_dispatch_immutable_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."dispatchId" IS DISTINCT FROM OLD."dispatchId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."conversationKey" IS DISTINCT FROM OLD."conversationKey"
       OR NEW."commandId" IS DISTINCT FROM OLD."commandId"
       OR NEW."commandSequence" IS DISTINCT FROM OLD."commandSequence"
       OR NEW."reservationId" IS DISTINCT FROM OLD."reservationId"
       OR NEW."initialRouteVersion" IS DISTINCT FROM OLD."initialRouteVersion"
       OR NEW."initialProtocolChatId" IS DISTINCT FROM OLD."initialProtocolChatId"
       OR NEW."initialProviderUserId" IS DISTINCT FROM OLD."initialProviderUserId"
       OR NEW."initialWebRouteId" IS DISTINCT FROM OLD."initialWebRouteId"
       OR NEW."initialRouteEvidence" IS DISTINCT FROM OLD."initialRouteEvidence"
       OR NEW."initialRouteSnapshotSha256" IS DISTINCT FROM OLD."initialRouteSnapshotSha256"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxOutboundDispatch immutable identity or initial route mutation rejected';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_outbound_dispatch_transition_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxOutboundDispatchTransition is append-only';
END;
$function$;

CREATE FUNCTION max_outbound_shadow_plan_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxOutboundShadowPlan is append-only';
END;
$function$;

CREATE FUNCTION max_provider_confirmation_cursor_monotonic_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."cursorId" IS DISTINCT FROM OLD."cursorId"
       OR NEW."consumerId" IS DISTINCT FROM OLD."consumerId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."matcherVersion" IS DISTINCT FROM OLD."matcherVersion"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxProviderConfirmationCursor immutable scope mutation rejected';
    END IF;
    IF NEW."optimisticVersion" <> OLD."optimisticVersion" + 1 THEN
        RAISE EXCEPTION 'MaxProviderConfirmationCursor optimistic version must advance once';
    END IF;
    IF NEW."lastJournalSequence" < OLD."lastJournalSequence"
       OR (NEW."lastJournalSequence" = OLD."lastJournalSequence"
           AND NEW."lastEventOrdinal" < OLD."lastEventOrdinal") THEN
        RAISE EXCEPTION 'MaxProviderConfirmationCursor regression rejected';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_provider_confirmation_decision_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxProviderConfirmationDecision is append-only';
END;
$function$;

CREATE FUNCTION max_provider_confirmation_decision_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    projection_evidence TEXT;
    projection_account TEXT;
    projection_matcher TEXT;
    target_account TEXT;
    target_dispatch TEXT;
    target_attempt TEXT;
BEGIN
    SELECT "evidenceId", "accountId", "matcherVersion"
    INTO projection_evidence, projection_account, projection_matcher
    FROM "MaxProviderConfirmationResolution" WHERE "resolutionId" = NEW."resolutionId";
    IF NOT FOUND OR projection_evidence IS DISTINCT FROM NEW."evidenceId"
       OR projection_account IS DISTINCT FROM NEW."accountId"
       OR projection_matcher IS DISTINCT FROM NEW."matcherVersion" THEN
        RAISE EXCEPTION 'MaxProviderConfirmationDecision resolution scope mismatch';
    END IF;
    IF NEW."dispatchId" IS NOT NULL THEN
        SELECT "accountId" INTO target_account FROM "MaxOutboundDispatch"
        WHERE "dispatchId" = NEW."dispatchId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationDecision Dispatch scope mismatch';
        END IF;
    END IF;
    IF NEW."attemptId" IS NOT NULL THEN
        SELECT "accountId", "dispatchId" INTO target_account, target_dispatch
        FROM "MaxOutboundDispatchAttempt" WHERE "attemptId" = NEW."attemptId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId"
           OR target_dispatch IS DISTINCT FROM NEW."dispatchId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationDecision Attempt scope mismatch';
        END IF;
    END IF;
    IF NEW."transitionId" IS NOT NULL THEN
        SELECT "accountId", "dispatchId", "attemptId" INTO target_account, target_dispatch, target_attempt
        FROM "MaxOutboundDispatchTransition" WHERE "transitionId" = NEW."transitionId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId"
           OR target_dispatch IS DISTINCT FROM NEW."dispatchId"
           OR target_attempt IS DISTINCT FROM NEW."attemptId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationDecision Transition scope mismatch';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_provider_confirmation_evidence_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxProviderConfirmationEvidence is append-only';
END;
$function$;

CREATE FUNCTION max_provider_confirmation_resolution_identity_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."resolutionId" IS DISTINCT FROM OLD."resolutionId"
       OR NEW."evidenceId" IS DISTINCT FROM OLD."evidenceId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."matcherVersion" IS DISTINCT FROM OLD."matcherVersion"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxProviderConfirmationResolution immutable identity mutation rejected';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_provider_confirmation_resolution_scope_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    evidence_account TEXT;
    evidence_matcher TEXT;
    target_account TEXT;
    target_dispatch TEXT;
    target_attempt TEXT;
BEGIN
    SELECT "accountId", "matcherVersion" INTO evidence_account, evidence_matcher
    FROM "MaxProviderConfirmationEvidence" WHERE "evidenceId" = NEW."evidenceId";
    IF NOT FOUND OR evidence_account IS DISTINCT FROM NEW."accountId"
       OR evidence_matcher IS DISTINCT FROM NEW."matcherVersion" THEN
        RAISE EXCEPTION 'MaxProviderConfirmationResolution evidence scope mismatch';
    END IF;
    IF NEW."canonicalEvidenceId" IS NOT NULL THEN
        SELECT "accountId" INTO target_account FROM "MaxProviderConfirmationEvidence"
        WHERE "evidenceId" = NEW."canonicalEvidenceId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationResolution canonical evidence scope mismatch';
        END IF;
    END IF;
    IF NEW."dispatchId" IS NOT NULL THEN
        SELECT "accountId" INTO target_account FROM "MaxOutboundDispatch"
        WHERE "dispatchId" = NEW."dispatchId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationResolution Dispatch scope mismatch';
        END IF;
    END IF;
    IF NEW."attemptId" IS NOT NULL THEN
        SELECT "accountId", "dispatchId" INTO target_account, target_dispatch
        FROM "MaxOutboundDispatchAttempt" WHERE "attemptId" = NEW."attemptId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId"
           OR target_dispatch IS DISTINCT FROM NEW."dispatchId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationResolution Attempt scope mismatch';
        END IF;
    END IF;
    IF NEW."transitionId" IS NOT NULL THEN
        SELECT "accountId", "dispatchId", "attemptId" INTO target_account, target_dispatch, target_attempt
        FROM "MaxOutboundDispatchTransition" WHERE "transitionId" = NEW."transitionId";
        IF NOT FOUND OR target_account IS DISTINCT FROM NEW."accountId"
           OR target_dispatch IS DISTINCT FROM NEW."dispatchId"
           OR target_attempt IS DISTINCT FROM NEW."attemptId" THEN
            RAISE EXCEPTION 'MaxProviderConfirmationResolution Transition scope mismatch';
        END IF;
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_raw_transport_event_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxRawTransportEvent is append-only';
END;
$function$;

CREATE FUNCTION max_route_observation_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxRouteObservation is append-only';
END;
$function$;

CREATE FUNCTION max_shadow_comparison_cursor_monotonic_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW."cursorId" IS DISTINCT FROM OLD."cursorId"
       OR NEW."runId" IS DISTINCT FROM OLD."runId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."comparisonVersion" IS DISTINCT FROM OLD."comparisonVersion"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor immutable scope mutation rejected';
    END IF;
    IF NEW."optimisticVersion" <> OLD."optimisticVersion" + 1 THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor optimistic version must advance once';
    END IF;
    IF NEW."lastJournalSequence" < OLD."lastJournalSequence" THEN
        RAISE EXCEPTION 'MaxShadowComparisonCursor regression rejected';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_shadow_comparison_result_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxShadowComparisonResult is append-only';
END;
$function$;

CREATE FUNCTION max_shadow_comparison_run_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
    actual_processed INTEGER;
    actual_matched INTEGER;
    actual_expected INTEGER;
    actual_regression INTEGER;
    actual_legacy_only INTEGER;
    actual_new_only INTEGER;
    actual_unsupported INTEGER;
    actual_quarantined INTEGER;
BEGIN
    IF NEW."runId" IS DISTINCT FROM OLD."runId"
       OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
       OR NEW."comparisonVersion" IS DISTINCT FROM OLD."comparisonVersion"
       OR NEW."legacyAdapterVersion" IS DISTINCT FROM OLD."legacyAdapterVersion"
       OR NEW."newNormalizerVersion" IS DISTINCT FROM OLD."newNormalizerVersion"
       OR NEW."startedAt" IS DISTINCT FROM OLD."startedAt"
       OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun immutable identity mutation rejected';
    END IF;
    IF OLD."state" <> 'running' THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun terminal state is immutable';
    END IF;
    SELECT count(*)::INTEGER,
           count(*) FILTER (WHERE "classification" = 'matched')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'expected_difference')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'regression')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'legacy_only')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'new_only')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'unsupported')::INTEGER,
           count(*) FILTER (WHERE "classification" = 'quarantined')::INTEGER
    INTO actual_processed, actual_matched, actual_expected, actual_regression,
         actual_legacy_only, actual_new_only, actual_unsupported, actual_quarantined
    FROM "MaxShadowComparisonResult"
    WHERE "runId" = OLD."runId" AND "accountId" = OLD."accountId"
      AND "comparisonVersion" = OLD."comparisonVersion";
    IF NEW."processedCount" <> actual_processed
       OR NEW."matchedCount" <> actual_matched
       OR NEW."expectedDifferenceCount" <> actual_expected
       OR NEW."regressionCount" <> actual_regression
       OR NEW."legacyOnlyCount" <> actual_legacy_only
       OR NEW."newOnlyCount" <> actual_new_only
       OR NEW."unsupportedCount" <> actual_unsupported
       OR NEW."quarantinedCount" <> actual_quarantined THEN
        RAISE EXCEPTION 'MaxShadowComparisonRun counters must equal immutable Result aggregates';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION max_shadow_semantic_diff_append_only_guard()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
    RAISE EXCEPTION 'MaxShadowSemanticDiff is append-only';
END;
$function$;


-- GuardTriggers
-- Bind each guard function to its journal table.

CREATE TRIGGER "MaxAccountSessionOwner_fence_guard" BEFORE DELETE OR UPDATE ON "MaxAccountSessionOwner" FOR EACH ROW EXECUTE FUNCTION max_account_session_owner_fence_guard();

CREATE TRIGGER "MaxInboundNormalizationResult_append_only" BEFORE DELETE OR UPDATE ON "MaxInboundNormalizationResult" FOR EACH ROW EXECUTE FUNCTION max_inbound_normalization_result_append_only_guard();

CREATE TRIGGER "MaxInboundNormalizedEvent_append_only" BEFORE DELETE OR UPDATE ON "MaxInboundNormalizedEvent" FOR EACH ROW EXECUTE FUNCTION max_inbound_normalized_event_append_only_guard();

CREATE TRIGGER "MaxOutboundCommand_append_only" BEFORE DELETE OR UPDATE ON "MaxOutboundCommand" FOR EACH ROW EXECUTE FUNCTION max_outbound_command_append_only_guard();

CREATE TRIGGER "MaxOutboundDispatch_immutable" BEFORE UPDATE ON "MaxOutboundDispatch" FOR EACH ROW EXECUTE FUNCTION max_outbound_dispatch_immutable_guard();

CREATE TRIGGER "MaxOutboundDispatchAttempt_immutable" BEFORE UPDATE ON "MaxOutboundDispatchAttempt" FOR EACH ROW EXECUTE FUNCTION max_outbound_dispatch_attempt_immutable_guard();

CREATE TRIGGER "MaxOutboundDispatchTransition_append_only" BEFORE DELETE OR UPDATE ON "MaxOutboundDispatchTransition" FOR EACH ROW EXECUTE FUNCTION max_outbound_dispatch_transition_append_only_guard();

CREATE TRIGGER "MaxOutboundShadowPlan_append_only" BEFORE DELETE OR UPDATE ON "MaxOutboundShadowPlan" FOR EACH ROW EXECUTE FUNCTION max_outbound_shadow_plan_append_only_guard();

CREATE TRIGGER "MaxProviderConfirmationCursor_monotonic" BEFORE UPDATE ON "MaxProviderConfirmationCursor" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_cursor_monotonic_guard();

CREATE TRIGGER "MaxProviderConfirmationDecision_append_only" BEFORE DELETE OR UPDATE ON "MaxProviderConfirmationDecision" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_decision_append_only_guard();

CREATE TRIGGER "MaxProviderConfirmationDecision_scope_coherent" BEFORE INSERT ON "MaxProviderConfirmationDecision" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_decision_scope_guard();

CREATE TRIGGER "MaxProviderConfirmationEvidence_append_only" BEFORE DELETE OR UPDATE ON "MaxProviderConfirmationEvidence" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_evidence_append_only_guard();

CREATE TRIGGER "MaxProviderConfirmationResolution_identity_immutable" BEFORE UPDATE ON "MaxProviderConfirmationResolution" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_resolution_identity_guard();

CREATE TRIGGER "MaxProviderConfirmationResolution_scope_coherent" BEFORE INSERT OR UPDATE ON "MaxProviderConfirmationResolution" FOR EACH ROW EXECUTE FUNCTION max_provider_confirmation_resolution_scope_guard();

CREATE TRIGGER "MaxRawTransportEvent_append_only" BEFORE DELETE OR UPDATE ON "MaxRawTransportEvent" FOR EACH ROW EXECUTE FUNCTION max_raw_transport_event_append_only_guard();

CREATE TRIGGER "MaxRouteObservation_append_only" BEFORE DELETE OR UPDATE ON "MaxRouteObservation" FOR EACH ROW EXECUTE FUNCTION max_route_observation_append_only_guard();

CREATE TRIGGER "MaxShadowComparisonCursor_monotonic" BEFORE UPDATE ON "MaxShadowComparisonCursor" FOR EACH ROW EXECUTE FUNCTION max_shadow_comparison_cursor_monotonic_guard();

CREATE TRIGGER "MaxShadowComparisonResult_append_only" BEFORE DELETE OR UPDATE ON "MaxShadowComparisonResult" FOR EACH ROW EXECUTE FUNCTION max_shadow_comparison_result_append_only_guard();

CREATE TRIGGER "MaxShadowComparisonRun_controlled_update" BEFORE UPDATE ON "MaxShadowComparisonRun" FOR EACH ROW EXECUTE FUNCTION max_shadow_comparison_run_guard();

CREATE TRIGGER "MaxShadowSemanticDiff_append_only" BEFORE DELETE OR UPDATE ON "MaxShadowSemanticDiff" FOR EACH ROW EXECUTE FUNCTION max_shadow_semantic_diff_append_only_guard();
