-- Stage 1: additive Raw Event Journal foundation. This migration is generated
-- for review only and is not applied by Stage 1.

CREATE TABLE "MaxRawTransportEvent" (
    "observationId" TEXT NOT NULL,
    "journalSequence" BIGSERIAL NOT NULL,
    "accountId" TEXT NOT NULL,
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
    CONSTRAINT "MaxRawTransportEvent_pkey" PRIMARY KEY ("observationId"),
    CONSTRAINT "MaxRawTransportEvent_replayAvailability_check"
        CHECK ("replayAvailability" IN ('available', 'quarantined')),
    CONSTRAINT "MaxRawTransportEvent_quarantineConsistency_check"
        CHECK (("replayAvailability" = 'available' AND "quarantineReason" IS NULL)
            OR ("replayAvailability" = 'quarantined' AND "quarantineReason" IS NOT NULL)),
    CONSTRAINT "MaxRawTransportEvent_payloadSizeBytes_check"
        CHECK ("payloadSizeBytes" >= 0)
);

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
    CONSTRAINT "MaxRawTransportProcessing_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaxRawTransportProcessing_state_check"
        CHECK ("state" IN ('pending', 'processing', 'completed', 'retryable', 'quarantined', 'dead_letter')),
    CONSTRAINT "MaxRawTransportProcessing_versions_check"
        CHECK ("attempts" >= 0 AND "leaseVersion" >= 0)
);

CREATE TABLE "MaxRawTransportCursor" (
    "id" TEXT NOT NULL,
    "consumerId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "parserVersion" TEXT NOT NULL,
    "lastJournalSequence" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxRawTransportCursor_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaxRawTransportCursor_positionVersion_check"
        CHECK ("lastJournalSequence" >= 0 AND "version" >= 0)
);

CREATE UNIQUE INDEX "MaxRawTransportEvent_journalSequence_key" ON "MaxRawTransportEvent"("journalSequence");
CREATE INDEX "MaxRawTransportEvent_accountId_journalSequence_idx" ON "MaxRawTransportEvent"("accountId", "journalSequence");
CREATE INDEX "MaxRawTransportEvent_accountId_observedAt_idx" ON "MaxRawTransportEvent"("accountId", "observedAt");
CREATE INDEX "MaxRawTransportEvent_accountId_providerEventId_idx" ON "MaxRawTransportEvent"("accountId", "providerEventId");
CREATE INDEX "MaxRawTransportEvent_accountId_frameId_idx" ON "MaxRawTransportEvent"("accountId", "frameId");
CREATE INDEX "MaxRawTransportEvent_accountId_transportSequence_idx" ON "MaxRawTransportEvent"("accountId", "transportSequence");
CREATE INDEX "MaxRawTransportEvent_payloadSha256_idx" ON "MaxRawTransportEvent"("payloadSha256");
CREATE INDEX "MaxRawTransportEvent_opcode_idx" ON "MaxRawTransportEvent"("opcode");
CREATE UNIQUE INDEX "MaxRawTransportProcessing_observationId_parserVersion_key" ON "MaxRawTransportProcessing"("observationId", "parserVersion");
CREATE INDEX "MaxRawTransportProcessing_state_leaseUntil_idx" ON "MaxRawTransportProcessing"("state", "leaseUntil");
CREATE INDEX "MaxRawTransportProcessing_claimedBy_leaseUntil_idx" ON "MaxRawTransportProcessing"("claimedBy", "leaseUntil");
CREATE INDEX "MaxRawTransportProcessing_parserVersion_state_idx" ON "MaxRawTransportProcessing"("parserVersion", "state");
CREATE UNIQUE INDEX "MaxRawTransportCursor_consumerId_accountId_parserVersion_key" ON "MaxRawTransportCursor"("consumerId", "accountId", "parserVersion");
CREATE INDEX "MaxRawTransportCursor_accountId_lastJournalSequence_idx" ON "MaxRawTransportCursor"("accountId", "lastJournalSequence");

ALTER TABLE "MaxRawTransportProcessing"
ADD CONSTRAINT "MaxRawTransportProcessing_observationId_fkey"
FOREIGN KEY ("observationId") REFERENCES "MaxRawTransportEvent"("observationId")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Raw evidence is unconditionally append-only in Stage 1. Future retention
-- must use a separately reviewed privileged database role or SECURITY DEFINER
-- maintenance function with an explicit privilege contract; a caller-set GUC
-- is intentionally not an authorization boundary.
CREATE FUNCTION "max_raw_transport_event_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxRawTransportEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxRawTransportEvent_append_only"
BEFORE UPDATE OR DELETE ON "MaxRawTransportEvent"
FOR EACH ROW EXECUTE FUNCTION "max_raw_transport_event_append_only_guard"();

-- Rollback (separately approved, never automatic): drop trigger/function,
-- cursor, processing, then raw table. Retained evidence must be exported or
-- explicitly disposed under the approved data-retention policy first.
