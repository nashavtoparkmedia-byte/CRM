-- Stage 3: additive shadow inbound normalization foundation.
-- Review/gate artifact only; never apply this migration to production here.

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
    CONSTRAINT "MaxInboundNormalizationResult_pkey" PRIMARY KEY ("normalizationResultId"),
    CONSTRAINT "MaxInboundNormalizationResult_status_check"
        CHECK ("status" IN ('normalized', 'unsupported', 'quarantined')),
    CONSTRAINT "MaxInboundNormalizationResult_count_sequence_check"
        CHECK ("eventCount" >= 0 AND "sourceJournalSequence" >= 0),
    CONSTRAINT "MaxInboundNormalizationResult_versions_check"
        CHECK (char_length("parserVersion") BETWEEN 1 AND 128
            AND "parserVersion" = btrim("parserVersion")
            AND "parserVersion" !~ '[[:cntrl:]]'
            AND char_length("envelopeVersion") BETWEEN 1 AND 128
            AND "envelopeVersion" = btrim("envelopeVersion")
            AND "envelopeVersion" !~ '[[:cntrl:]]'),
    CONSTRAINT "MaxInboundNormalizationResult_issue_check"
        CHECK (("issueCode" IS NULL OR (char_length("issueCode") BETWEEN 1 AND 128
                    AND "issueCode" ~ '^[A-Z0-9_]+$'))
            AND ("safeIssueSummary" IS NULL OR char_length("safeIssueSummary") BETWEEN 1 AND 512)),
    CONSTRAINT "MaxInboundNormalizationResult_account_time_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128
            AND "accountId" = btrim("accountId")
            AND "completedAt" >= "startedAt")
);

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
    CONSTRAINT "MaxInboundNormalizedEvent_pkey" PRIMARY KEY ("normalizedEventId"),
    CONSTRAINT "MaxInboundNormalizedEvent_kind_check"
        CHECK ("eventKind" IN ('message', 'reaction', 'receipt', 'route_evidence', 'unsupported')),
    CONSTRAINT "MaxInboundNormalizedEvent_direction_check"
        CHECK ("direction" IN ('inbound', 'outbound_echo', 'system', 'unknown')),
    CONSTRAINT "MaxInboundNormalizedEvent_origin_check"
        CHECK ("origin" IN ('live', 'history', 'replay', 'unknown')),
    CONSTRAINT "MaxInboundNormalizedEvent_ordinal_sequence_check"
        CHECK ("eventOrdinal" >= 0 AND "sourceJournalSequence" >= 0),
    CONSTRAINT "MaxInboundNormalizedEvent_versions_hash_check"
        CHECK (char_length("parserVersion") BETWEEN 1 AND 128
            AND "parserVersion" = btrim("parserVersion")
            AND "parserVersion" !~ '[[:cntrl:]]'
            AND char_length("envelopeVersion") BETWEEN 1 AND 128
            AND "envelopeVersion" = btrim("envelopeVersion")
            AND "envelopeVersion" !~ '[[:cntrl:]]'
            AND "semanticSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "MaxInboundNormalizedEvent_account_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128 AND "accountId" = btrim("accountId")),
    CONSTRAINT "MaxInboundNormalizedEvent_provider_identifiers_check"
        CHECK (("providerMessageId" IS NULL OR (char_length("providerMessageId") BETWEEN 1 AND 512
                    AND "providerMessageId" = btrim("providerMessageId") AND "providerMessageId" !~ '[[:cntrl:]]'))
            AND ("providerUserId" IS NULL OR (char_length("providerUserId") BETWEEN 1 AND 512
                    AND "providerUserId" = btrim("providerUserId") AND "providerUserId" !~ '[[:cntrl:]]'))
            AND ("protocolChatId" IS NULL OR (char_length("protocolChatId") BETWEEN 1 AND 512
                    AND "protocolChatId" = btrim("protocolChatId") AND "protocolChatId" !~ '[[:cntrl:]]'))
            AND ("webRouteId" IS NULL OR (char_length("webRouteId") BETWEEN 1 AND 512
                    AND "webRouteId" = btrim("webRouteId") AND "webRouteId" !~ '[[:cntrl:]]'))
            AND ("clientMessageId" IS NULL OR (char_length("clientMessageId") BETWEEN 1 AND 512
                    AND "clientMessageId" = btrim("clientMessageId") AND "clientMessageId" !~ '[[:cntrl:]]'))
            AND ("targetProviderMessageId" IS NULL OR (char_length("targetProviderMessageId") BETWEEN 1 AND 512
                    AND "targetProviderMessageId" = btrim("targetProviderMessageId") AND "targetProviderMessageId" !~ '[[:cntrl:]]'))),
    CONSTRAINT "MaxInboundNormalizedEvent_payload_size_check"
        CHECK (pg_column_size("normalizedPayload") <= 1048576)
);

CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_source_parser_key"
ON "MaxInboundNormalizationResult"("accountId", "sourceObservationId", "parserVersion");
CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_result_key"
ON "MaxInboundNormalizationResult"("accountId", "normalizationResultId");
CREATE UNIQUE INDEX "MaxInboundNormalizationResult_account_result_source_parser_key"
ON "MaxInboundNormalizationResult"("accountId", "normalizationResultId", "sourceObservationId", "parserVersion");
CREATE INDEX "MaxInboundNormalizationResult_account_sequence_idx"
ON "MaxInboundNormalizationResult"("accountId", "sourceJournalSequence");
CREATE INDEX "MaxInboundNormalizationResult_account_parser_sequence_idx"
ON "MaxInboundNormalizationResult"("accountId", "parserVersion", "sourceJournalSequence");
CREATE INDEX "MaxInboundNormalizationResult_status_idx"
ON "MaxInboundNormalizationResult"("status");

CREATE UNIQUE INDEX "MaxInboundNormalizedEvent_result_ordinal_key"
ON "MaxInboundNormalizedEvent"("normalizationResultId", "eventOrdinal");
CREATE INDEX "MaxInboundNormalizedEvent_account_sequence_idx"
ON "MaxInboundNormalizedEvent"("accountId", "sourceJournalSequence");
CREATE INDEX "MaxInboundNormalizedEvent_account_parser_sequence_idx"
ON "MaxInboundNormalizedEvent"("accountId", "parserVersion", "sourceJournalSequence");
CREATE INDEX "MaxInboundNormalizedEvent_account_provider_message_idx"
ON "MaxInboundNormalizedEvent"("accountId", "providerMessageId");
CREATE INDEX "MaxInboundNormalizedEvent_account_protocol_chat_idx"
ON "MaxInboundNormalizedEvent"("accountId", "protocolChatId");
CREATE INDEX "MaxInboundNormalizedEvent_account_provider_user_idx"
ON "MaxInboundNormalizedEvent"("accountId", "providerUserId");
CREATE INDEX "MaxInboundNormalizedEvent_target_provider_message_idx"
ON "MaxInboundNormalizedEvent"("targetProviderMessageId");
CREATE INDEX "MaxInboundNormalizedEvent_kind_idx"
ON "MaxInboundNormalizedEvent"("eventKind");

ALTER TABLE "MaxInboundNormalizationResult"
ADD CONSTRAINT "MaxInboundNormalizationResult_account_source_fkey"
FOREIGN KEY ("accountId", "sourceObservationId")
REFERENCES "MaxRawTransportEvent"("accountId", "observationId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxInboundNormalizedEvent"
ADD CONSTRAINT "MaxInboundNormalizedEvent_result_account_source_parser_fkey"
FOREIGN KEY ("accountId", "normalizationResultId", "sourceObservationId", "parserVersion")
REFERENCES "MaxInboundNormalizationResult"("accountId", "normalizationResultId", "sourceObservationId", "parserVersion")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Completed normalization artifacts are unconditionally append-only. No
-- caller-controlled GUC or session flag can authorize mutation/deletion.
CREATE FUNCTION "max_inbound_normalization_result_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxInboundNormalizationResult is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxInboundNormalizationResult_append_only"
BEFORE UPDATE OR DELETE ON "MaxInboundNormalizationResult"
FOR EACH ROW EXECUTE FUNCTION "max_inbound_normalization_result_append_only_guard"();

CREATE FUNCTION "max_inbound_normalized_event_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxInboundNormalizedEvent is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxInboundNormalizedEvent_append_only"
BEFORE UPDATE OR DELETE ON "MaxInboundNormalizedEvent"
FOR EACH ROW EXECUTE FUNCTION "max_inbound_normalized_event_append_only_guard"();

-- Rollback is never automatic. A separately approved retention-aware follow-up
-- must disposition immutable normalization evidence before reversing objects.
