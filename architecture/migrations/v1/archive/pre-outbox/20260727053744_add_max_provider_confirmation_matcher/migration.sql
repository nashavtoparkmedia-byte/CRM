-- Stage 6: durable exact provider-confirmation evidence and matcher projection.
-- Additive and dormant: no runtime wiring, provider query, or provider action.

CREATE UNIQUE INDEX "MaxInboundNormalizedEvent_account_event_key"
ON "MaxInboundNormalizedEvent"("accountId", "normalizedEventId");

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
    CONSTRAINT "MaxProviderConfirmationEvidence_pkey" PRIMARY KEY ("evidenceId"),
    CONSTRAINT "MaxProviderConfirmationEvidence_identity_check" CHECK (
        char_length("evidenceId") BETWEEN 1 AND 256
        AND "evidenceId" = btrim("evidenceId")
        AND "evidenceId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND char_length("sourceNormalizedEventId") BETWEEN 1 AND 256
        AND "sourceNormalizedEventId" = btrim("sourceNormalizedEventId")
        AND char_length("sourceObservationId") BETWEEN 1 AND 256
        AND "sourceObservationId" = btrim("sourceObservationId")
        AND "sourceJournalSequence" >= 0
        AND "sourceEventOrdinal" >= 0
        AND char_length("matcherVersion") BETWEEN 1 AND 128
        AND "matcherVersion" = btrim("matcherVersion")
        AND char_length("evidenceVersion") BETWEEN 1 AND 128
        AND "evidenceVersion" = btrim("evidenceVersion")
    ),
    CONSTRAINT "MaxProviderConfirmationEvidence_kind_check" CHECK (
        "evidenceKind" IN ('outbound_echo', 'provider_acceptance_receipt',
            'recipient_delivery_receipt', 'recipient_read_receipt',
            'provider_absence', 'unknown_receipt', 'unsupported')
    ),
    CONSTRAINT "MaxProviderConfirmationEvidence_exact_fields_check" CHECK (
        ("providerMessageId" IS NULL OR (char_length("providerMessageId") BETWEEN 1 AND 512
            AND "providerMessageId" = btrim("providerMessageId") AND "providerMessageId" !~ '[[:cntrl:]]'))
        AND ("attemptCorrelationId" IS NULL OR (char_length("attemptCorrelationId") BETWEEN 1 AND 256
            AND "attemptCorrelationId" = btrim("attemptCorrelationId") AND "attemptCorrelationId" !~ '[[:cntrl:]]'))
        AND ("clientMessageId" IS NULL OR (char_length("clientMessageId") BETWEEN 1 AND 256
            AND "clientMessageId" = btrim("clientMessageId") AND "clientMessageId" !~ '[[:cntrl:]]'))
        AND ("protocolChatId" IS NULL OR (char_length("protocolChatId") BETWEEN 1 AND 512
            AND "protocolChatId" = btrim("protocolChatId") AND "protocolChatId" !~ '[[:cntrl:]]'))
        AND ("providerUserId" IS NULL OR (char_length("providerUserId") BETWEEN 1 AND 512
            AND "providerUserId" = btrim("providerUserId") AND "providerUserId" !~ '[[:cntrl:]]'))
        AND ("webRouteId" IS NULL OR (char_length("webRouteId") BETWEEN 1 AND 512
            AND "webRouteId" = btrim("webRouteId") AND "webRouteId" !~ '[[:cntrl:]]'))
        AND "evidenceSha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("safeMetadata") = 'object'
        AND pg_column_size("safeMetadata") <= 16384
    )
);

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
    CONSTRAINT "MaxProviderConfirmationResolution_pkey" PRIMARY KEY ("resolutionId"),
    CONSTRAINT "MaxProviderConfirmationResolution_identity_check" CHECK (
        char_length("resolutionId") BETWEEN 1 AND 256
        AND "resolutionId" = btrim("resolutionId")
        AND "resolutionId" !~ '[[:cntrl:]]'
        AND char_length("evidenceId") BETWEEN 1 AND 256
        AND "evidenceId" = btrim("evidenceId")
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND char_length("matcherVersion") BETWEEN 1 AND 128
        AND "matcherVersion" = btrim("matcherVersion")
        AND "resolutionVersion" >= 0 AND "retryCount" >= 0
    ),
    CONSTRAINT "MaxProviderConfirmationResolution_state_check" CHECK (
        "status" IN ('pending', 'deferred', 'matched', 'duplicate', 'unmatched',
            'ambiguous', 'ignored', 'quarantined')
        AND "matchMethod" IN ('attempt_correlation_id', 'client_message_id',
            'existing_provider_message_id', 'provider_absence_reference', 'none')
        AND jsonb_typeof("candidateDispatchIds") = 'array'
        AND jsonb_typeof("candidateAttemptIds") = 'array'
        AND jsonb_array_length("candidateDispatchIds") <= 64
        AND jsonb_array_length("candidateAttemptIds") <= 64
        AND ("issueCode" IS NULL OR "issueCode" ~ '^[A-Z0-9_]{1,128}$')
        AND ("safeIssueSummary" IS NULL OR (char_length("safeIssueSummary") BETWEEN 1 AND 512
            AND "safeIssueSummary" !~ '[[:cntrl:]]'))
        AND ("status" IN ('pending', 'deferred', 'ambiguous') OR "resolvedAt" IS NOT NULL)
        AND (("status" = 'deferred') = ("nextRetryAt" IS NOT NULL))
        AND ("status" NOT IN ('matched', 'duplicate') OR ("dispatchId" IS NOT NULL AND "attemptId" IS NOT NULL))
        AND ("status" <> 'matched' OR "transitionId" IS NOT NULL)
        AND ("status" <> 'duplicate' OR "canonicalEvidenceId" IS NOT NULL)
        AND ("status" NOT IN ('pending', 'deferred', 'unmatched', 'ambiguous', 'ignored', 'quarantined')
            OR "transitionId" IS NULL)
        AND ("resolvedBy" IS NULL OR (char_length("resolvedBy") BETWEEN 1 AND 256
            AND "resolvedBy" = btrim("resolvedBy") AND "resolvedBy" !~ '[[:cntrl:]]'))
        AND ("resolutionReason" IS NULL OR (char_length("resolutionReason") BETWEEN 1 AND 512
            AND "resolutionReason" = btrim("resolutionReason") AND "resolutionReason" !~ '[[:cntrl:]]'))
    )
);

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
    CONSTRAINT "MaxProviderConfirmationDecision_pkey" PRIMARY KEY ("decisionId"),
    CONSTRAINT "MaxProviderConfirmationDecision_identity_check" CHECK (
        char_length("decisionId") BETWEEN 1 AND 256
        AND "decisionId" = btrim("decisionId")
        AND "decisionId" !~ '[[:cntrl:]]'
        AND char_length("resolutionId") BETWEEN 1 AND 256
        AND "resolutionId" = btrim("resolutionId")
        AND char_length("evidenceId") BETWEEN 1 AND 256
        AND "evidenceId" = btrim("evidenceId")
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND "decisionSequence" > 0
        AND char_length("matcherVersion") BETWEEN 1 AND 128
        AND "matcherVersion" = btrim("matcherVersion")
        AND char_length("decisionType") BETWEEN 1 AND 128
        AND "decisionType" ~ '^[a-z0-9_]+$'
        AND char_length("actor") BETWEEN 1 AND 256
        AND "actor" = btrim("actor") AND "actor" !~ '[[:cntrl:]]'
        AND char_length("reason") BETWEEN 1 AND 512
        AND "reason" = btrim("reason") AND "reason" !~ '[[:cntrl:]]'
        AND "decisionSha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("safeMetadata") = 'object'
        AND pg_column_size("safeMetadata") <= 16384
    ),
    CONSTRAINT "MaxProviderConfirmationDecision_state_check" CHECK (
        ("fromStatus" IS NULL OR "fromStatus" IN ('pending', 'deferred', 'matched',
            'duplicate', 'unmatched', 'ambiguous', 'ignored', 'quarantined'))
        AND "toStatus" IN ('pending', 'deferred', 'matched', 'duplicate',
            'unmatched', 'ambiguous', 'ignored', 'quarantined')
        AND "resolutionVersionBefore" >= 0
        AND "resolutionVersionAfter" >= "resolutionVersionBefore"
        AND "decisionSequence" = "resolutionVersionAfter" + 1
        AND (("fromStatus" IS NULL AND "resolutionVersionBefore" = 0
                AND "resolutionVersionAfter" = 0)
            OR ("fromStatus" IS NOT NULL
                AND "resolutionVersionAfter" = "resolutionVersionBefore" + 1))
        AND ("transitionId" IS NULL OR ("dispatchId" IS NOT NULL AND "attemptId" IS NOT NULL))
    )
);

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
    CONSTRAINT "MaxProviderConfirmationCursor_pkey" PRIMARY KEY ("cursorId"),
    CONSTRAINT "MaxProviderConfirmationCursor_value_check" CHECK (
        char_length("cursorId") BETWEEN 1 AND 256
        AND "cursorId" = btrim("cursorId")
        AND char_length("consumerId") BETWEEN 1 AND 256
        AND "consumerId" = btrim("consumerId")
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND char_length("matcherVersion") BETWEEN 1 AND 128
        AND "matcherVersion" = btrim("matcherVersion")
        AND "lastJournalSequence" >= 0
        AND "lastEventOrdinal" >= 0
        AND "optimisticVersion" >= 0
    )
);

CREATE UNIQUE INDEX "MaxProviderConfirmationEvidence_account_event_matcher_key"
ON "MaxProviderConfirmationEvidence"("accountId", "sourceNormalizedEventId", "matcherVersion");
CREATE INDEX "MaxProviderConfirmationEvidence_account_source_order_idx"
ON "MaxProviderConfirmationEvidence"("accountId", "sourceJournalSequence", "sourceEventOrdinal");
CREATE INDEX "MaxProviderConfirmationEvidence_account_provider_message_idx"
ON "MaxProviderConfirmationEvidence"("accountId", "providerMessageId");
CREATE INDEX "MaxProviderConfirmationEvidence_account_attempt_correlation_idx"
ON "MaxProviderConfirmationEvidence"("accountId", "attemptCorrelationId");
CREATE INDEX "MaxProviderConfirmationEvidence_account_client_message_idx"
ON "MaxProviderConfirmationEvidence"("accountId", "clientMessageId");
CREATE INDEX "MaxProviderConfirmationEvidence_kind_created_idx"
ON "MaxProviderConfirmationEvidence"("evidenceKind", "createdAt");

CREATE UNIQUE INDEX "MaxProviderConfirmationResolution_evidence_key"
ON "MaxProviderConfirmationResolution"("evidenceId");
CREATE INDEX "MaxProviderConfirmationResolution_account_matcher_status_idx"
ON "MaxProviderConfirmationResolution"("accountId", "matcherVersion", "status", "createdAt");
CREATE INDEX "MaxProviderConfirmationResolution_dispatch_status_idx"
ON "MaxProviderConfirmationResolution"("dispatchId", "status");
CREATE INDEX "MaxProviderConfirmationResolution_canonical_evidence_idx"
ON "MaxProviderConfirmationResolution"("canonicalEvidenceId");

CREATE UNIQUE INDEX "MaxProviderConfirmationDecision_resolution_sequence_key"
ON "MaxProviderConfirmationDecision"("resolutionId", "decisionSequence");
CREATE INDEX "MaxProviderConfirmationDecision_account_created_idx"
ON "MaxProviderConfirmationDecision"("accountId", "createdAt");
CREATE INDEX "MaxProviderConfirmationDecision_evidence_idx"
ON "MaxProviderConfirmationDecision"("evidenceId", "createdAt");
CREATE INDEX "MaxProviderConfirmationDecision_dispatch_idx"
ON "MaxProviderConfirmationDecision"("dispatchId", "createdAt");

CREATE UNIQUE INDEX "MaxProviderConfirmationCursor_consumer_account_matcher_key"
ON "MaxProviderConfirmationCursor"("consumerId", "accountId", "matcherVersion");
CREATE INDEX "MaxProviderConfirmationCursor_account_source_order_idx"
ON "MaxProviderConfirmationCursor"("accountId", "lastJournalSequence", "lastEventOrdinal");

ALTER TABLE "MaxProviderConfirmationEvidence"
ADD CONSTRAINT "MaxProviderConfirmationEvidence_account_event_fkey"
FOREIGN KEY ("accountId", "sourceNormalizedEventId")
REFERENCES "MaxInboundNormalizedEvent"("accountId", "normalizedEventId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxProviderConfirmationResolution"
ADD CONSTRAINT "MaxProviderConfirmationResolution_evidence_fkey"
FOREIGN KEY ("evidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationResolution"
ADD CONSTRAINT "MaxProviderConfirmationResolution_canonical_evidence_fkey"
FOREIGN KEY ("canonicalEvidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationResolution"
ADD CONSTRAINT "MaxProviderConfirmationResolution_dispatch_fkey"
FOREIGN KEY ("dispatchId") REFERENCES "MaxOutboundDispatch"("dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationResolution"
ADD CONSTRAINT "MaxProviderConfirmationResolution_attempt_fkey"
FOREIGN KEY ("attemptId") REFERENCES "MaxOutboundDispatchAttempt"("attemptId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationResolution"
ADD CONSTRAINT "MaxProviderConfirmationResolution_transition_fkey"
FOREIGN KEY ("transitionId") REFERENCES "MaxOutboundDispatchTransition"("transitionId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxProviderConfirmationDecision"
ADD CONSTRAINT "MaxProviderConfirmationDecision_resolution_fkey"
FOREIGN KEY ("resolutionId") REFERENCES "MaxProviderConfirmationResolution"("resolutionId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationDecision"
ADD CONSTRAINT "MaxProviderConfirmationDecision_evidence_fkey"
FOREIGN KEY ("evidenceId") REFERENCES "MaxProviderConfirmationEvidence"("evidenceId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationDecision"
ADD CONSTRAINT "MaxProviderConfirmationDecision_dispatch_fkey"
FOREIGN KEY ("dispatchId") REFERENCES "MaxOutboundDispatch"("dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationDecision"
ADD CONSTRAINT "MaxProviderConfirmationDecision_attempt_fkey"
FOREIGN KEY ("attemptId") REFERENCES "MaxOutboundDispatchAttempt"("attemptId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxProviderConfirmationDecision"
ADD CONSTRAINT "MaxProviderConfirmationDecision_transition_fkey"
FOREIGN KEY ("transitionId") REFERENCES "MaxOutboundDispatchTransition"("transitionId")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cross-row account, matcher, and target coherence is enforced in PostgreSQL;
-- callers cannot construct a cross-account resolution or audit projection.
CREATE FUNCTION "max_provider_confirmation_resolution_scope_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationResolution_scope_coherent"
BEFORE INSERT OR UPDATE ON "MaxProviderConfirmationResolution"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_resolution_scope_guard"();

CREATE FUNCTION "max_provider_confirmation_decision_scope_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationDecision_scope_coherent"
BEFORE INSERT ON "MaxProviderConfirmationDecision"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_decision_scope_guard"();

-- Immutable physical evidence and append-only decisions have no caller- or
-- GUC-controlled bypass. Any UPDATE or DELETE is rejected for every role.
CREATE FUNCTION "max_provider_confirmation_evidence_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxProviderConfirmationEvidence is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationEvidence_append_only"
BEFORE UPDATE OR DELETE ON "MaxProviderConfirmationEvidence"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_evidence_append_only_guard"();

CREATE FUNCTION "max_provider_confirmation_decision_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxProviderConfirmationDecision is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationDecision_append_only"
BEFORE UPDATE OR DELETE ON "MaxProviderConfirmationDecision"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_decision_append_only_guard"();

CREATE FUNCTION "max_provider_confirmation_resolution_identity_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationResolution_identity_immutable"
BEFORE UPDATE ON "MaxProviderConfirmationResolution"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_resolution_identity_guard"();

CREATE FUNCTION "max_provider_confirmation_cursor_monotonic_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxProviderConfirmationCursor_monotonic"
BEFORE UPDATE ON "MaxProviderConfirmationCursor"
FOR EACH ROW EXECUTE FUNCTION "max_provider_confirmation_cursor_monotonic_guard"();

-- Rollback requires a separately approved retention-aware additive migration.
