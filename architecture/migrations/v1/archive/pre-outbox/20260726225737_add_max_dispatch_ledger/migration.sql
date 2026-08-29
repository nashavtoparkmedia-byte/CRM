-- Stage 5: additive Dispatch Ledger and honest outbound state machine.
-- This stage is dormant: it records contracts and never performs provider actions.

ALTER TABLE "MaxOutboundCommandReservation"
ADD COLUMN "dispatchId" TEXT;

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_source_key"
ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence");

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
    CONSTRAINT "MaxOutboundDispatch_pkey" PRIMARY KEY ("dispatchId"),
    CONSTRAINT "MaxOutboundDispatch_identity_check" CHECK (
        char_length("dispatchId") BETWEEN 1 AND 256
        AND "dispatchId" = btrim("dispatchId")
        AND "dispatchId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND char_length("conversationKey") BETWEEN 1 AND 256
        AND "conversationKey" = btrim("conversationKey")
        AND char_length("commandId") BETWEEN 1 AND 256
        AND "commandId" = btrim("commandId")
        AND "commandSequence" > 0
        AND char_length("reservationId") BETWEEN 1 AND 256
        AND "reservationId" = btrim("reservationId")
    ),
    CONSTRAINT "MaxOutboundDispatch_state_check" CHECK (
        "state" IN ('queued', 'dispatching', 'sent_to_provider_client',
            'awaiting_confirmation', 'reconciliation_required', 'provider_confirmed',
            'retryable_failed', 'hard_failed', 'dead_letter')
        AND "stateVersion" >= 1
        AND "attemptCount" >= 0
    ),
    CONSTRAINT "MaxOutboundDispatch_initial_route_check" CHECK (
        "initialRouteVersion" >= 0
        AND char_length("initialProtocolChatId") BETWEEN 1 AND 512
        AND "initialProtocolChatId" = btrim("initialProtocolChatId")
        AND "initialProtocolChatId" !~ '[[:cntrl:]]'
        AND ("initialProviderUserId" IS NULL OR (
            char_length("initialProviderUserId") BETWEEN 1 AND 512
            AND "initialProviderUserId" = btrim("initialProviderUserId")
            AND "initialProviderUserId" !~ '[[:cntrl:]]'))
        AND ("initialWebRouteId" IS NULL OR (
            char_length("initialWebRouteId") BETWEEN 1 AND 512
            AND "initialWebRouteId" = btrim("initialWebRouteId")
            AND "initialWebRouteId" !~ '[[:cntrl:]]'))
        AND jsonb_typeof("initialRouteEvidence") = 'object'
        AND pg_column_size("initialRouteEvidence") <= 65536
        AND "initialRouteSnapshotSha256" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "MaxOutboundDispatch_confirmation_check" CHECK (
        (("providerMessageId" IS NULL AND "providerConfirmedAt" IS NULL)
            OR ("providerMessageId" IS NOT NULL AND "providerConfirmedAt" IS NOT NULL
                AND char_length("providerMessageId") BETWEEN 1 AND 512
                AND "providerMessageId" = btrim("providerMessageId")
                AND "providerMessageId" !~ '[[:cntrl:]]'))
        AND (("state" = 'provider_confirmed') = ("providerMessageId" IS NOT NULL))
        AND (("state" = 'reconciliation_required') = ("reconciliationRequiredAt" IS NOT NULL))
        AND (("state" IN ('provider_confirmed', 'hard_failed', 'dead_letter')) = ("terminalAt" IS NOT NULL))
        AND ("currentAttemptId" IS NULL OR (
            char_length("currentAttemptId") BETWEEN 1 AND 256
            AND "currentAttemptId" = btrim("currentAttemptId")
            AND "currentAttemptId" !~ '[[:cntrl:]]'))
    )
);

CREATE TABLE "MaxOutboundDispatchLane" (
    "accountId" TEXT NOT NULL,
    "conversationKey" TEXT NOT NULL,
    "nextPhysicalSequence" INTEGER NOT NULL DEFAULT 1,
    "optimisticVersion" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxOutboundDispatchLane_pkey" PRIMARY KEY ("accountId", "conversationKey"),
    CONSTRAINT "MaxOutboundDispatchLane_sequence_version_check" CHECK (
        "nextPhysicalSequence" > 0 AND "optimisticVersion" >= 0
    )
);

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
    CONSTRAINT "MaxOutboundDispatchAttempt_pkey" PRIMARY KEY ("attemptId"),
    CONSTRAINT "MaxOutboundDispatchAttempt_identity_version_check" CHECK (
        char_length("attemptId") BETWEEN 1 AND 256
        AND "attemptId" = btrim("attemptId")
        AND "attemptId" !~ '[[:cntrl:]]'
        AND char_length("dispatchId") BETWEEN 1 AND 256
        AND "dispatchId" = btrim("dispatchId")
        AND "attemptNumber" > 0
        AND "attemptVersion" >= 0
        AND "senderFencingEpoch" >= 0
        AND "routeVersion" >= 0
        AND char_length("senderOwnerId") BETWEEN 1 AND 256
        AND "senderOwnerId" = btrim("senderOwnerId")
        AND "senderOwnerId" !~ '[[:cntrl:]]'
        AND char_length("attemptCorrelationId") BETWEEN 1 AND 256
        AND "attemptCorrelationId" = btrim("attemptCorrelationId")
        AND "attemptCorrelationId" !~ '[[:cntrl:]]'
        AND char_length("protocolChatId") BETWEEN 1 AND 512
        AND "protocolChatId" = btrim("protocolChatId")
        AND "protocolChatId" !~ '[[:cntrl:]]'
        AND ("providerUserId" IS NULL OR (
            char_length("providerUserId") BETWEEN 1 AND 512
            AND "providerUserId" = btrim("providerUserId")
            AND "providerUserId" !~ '[[:cntrl:]]'))
        AND ("webRouteId" IS NULL OR (
            char_length("webRouteId") BETWEEN 1 AND 512
            AND "webRouteId" = btrim("webRouteId")
            AND "webRouteId" !~ '[[:cntrl:]]'))
        AND "routeSnapshotSha256" ~ '^[0-9a-f]{64}$'
        AND "claimUntil" > "preparedAt"
    ),
    CONSTRAINT "MaxOutboundDispatchAttempt_state_check" CHECK (
        "attemptState" IN ('prepared', 'physical_action_started', 'client_action_accepted',
            'awaiting_confirmation', 'outcome_unknown', 'provider_confirmed',
            'pre_action_failed', 'hard_failed')
    ),
    CONSTRAINT "MaxOutboundDispatchAttempt_timestamps_check" CHECK (
        ("physicalActionStartedAt" IS NULL OR "physicalActionStartedAt" >= "preparedAt")
        AND ("clientActionAcceptedAt" IS NULL OR (
            "physicalActionStartedAt" IS NOT NULL AND "clientActionAcceptedAt" >= "physicalActionStartedAt"))
        AND ("awaitingConfirmationAt" IS NULL OR (
            "clientActionAcceptedAt" IS NOT NULL AND "awaitingConfirmationAt" >= "clientActionAcceptedAt"))
        AND ("outcomeUnknownAt" IS NULL OR "outcomeUnknownAt" >= "preparedAt")
        AND ("completedAt" IS NULL OR "completedAt" >= "preparedAt")
        AND (("attemptState" = 'prepared') = ("physicalActionStartedAt" IS NULL
            AND "clientActionAcceptedAt" IS NULL AND "awaitingConfirmationAt" IS NULL
            AND "outcomeUnknownAt" IS NULL AND "completedAt" IS NULL))
        AND ("attemptState" NOT IN ('physical_action_started', 'client_action_accepted',
            'awaiting_confirmation', 'provider_confirmed') OR "physicalActionStartedAt" IS NOT NULL)
        AND ("attemptState" NOT IN ('client_action_accepted', 'awaiting_confirmation')
            OR "clientActionAcceptedAt" IS NOT NULL)
        AND ("attemptState" <> 'awaiting_confirmation'
            OR "awaitingConfirmationAt" IS NOT NULL)
        AND ("attemptState" <> 'outcome_unknown' OR "outcomeUnknownAt" IS NOT NULL)
        AND ("attemptState" NOT IN ('provider_confirmed', 'pre_action_failed', 'hard_failed')
            OR "completedAt" IS NOT NULL)
        AND ("safeErrorCode" IS NULL OR (
            char_length("safeErrorCode") BETWEEN 1 AND 128
            AND "safeErrorCode" ~ '^[A-Z0-9_]+$'))
    )
);

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
    CONSTRAINT "MaxOutboundDispatchTransition_pkey" PRIMARY KEY ("transitionId"),
    CONSTRAINT "MaxOutboundDispatchTransition_identity_check" CHECK (
        char_length("transitionId") BETWEEN 1 AND 256
        AND "transitionId" = btrim("transitionId")
        AND "transitionId" !~ '[[:cntrl:]]'
        AND char_length("transitionIdempotencyKey") BETWEEN 1 AND 256
        AND "transitionIdempotencyKey" = btrim("transitionIdempotencyKey")
        AND "transitionIdempotencyKey" !~ '[[:cntrl:]]'
        AND "transitionSequence" > 0
        AND "stateVersionBefore" >= 0
        AND "stateVersionAfter" = "stateVersionBefore" + 1
        AND "evidenceSha256" ~ '^[0-9a-f]{64}$'
        AND jsonb_typeof("safeEvidenceMetadata") = 'object'
        AND pg_column_size("safeEvidenceMetadata") <= 32768
        AND ("evidenceReference" IS NULL OR (
            char_length("evidenceReference") BETWEEN 1 AND 512
            AND "evidenceReference" = btrim("evidenceReference")
            AND "evidenceReference" !~ '[[:cntrl:]]'
            AND "evidenceReference" !~* '^(https?|wss?)://'))
    ),
    CONSTRAINT "MaxOutboundDispatchTransition_state_check" CHECK (
        ("fromState" IS NULL OR "fromState" IN ('queued', 'dispatching',
            'sent_to_provider_client', 'awaiting_confirmation', 'reconciliation_required',
            'provider_confirmed', 'retryable_failed', 'hard_failed', 'dead_letter'))
        AND "toState" IN ('queued', 'dispatching', 'sent_to_provider_client',
            'awaiting_confirmation', 'reconciliation_required', 'provider_confirmed',
            'retryable_failed', 'hard_failed', 'dead_letter')
        AND char_length("eventType") BETWEEN 1 AND 128
        AND "eventType" ~ '^[a-z0-9_]+$'
        AND "evidenceKind" IN ('dispatch_creation', 'sender_authority', 'physical_marker',
            'client_ack', 'awaiting_confirmation', 'unknown_outcome',
            'exact_provider_confirmation', 'provider_absence', 'retry_policy',
            'contract_failure', 'dead_letter_policy', 'terminal_skip', 'recovery')
    )
);

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
    CONSTRAINT "MaxOutboundReconciliationTask_pkey" PRIMARY KEY ("reconciliationId"),
    CONSTRAINT "MaxOutboundReconciliationTask_identity_version_check" CHECK (
        char_length("reconciliationId") BETWEEN 1 AND 256
        AND "reconciliationId" = btrim("reconciliationId")
        AND "reconciliationId" !~ '[[:cntrl:]]'
        AND "taskVersion" >= 0
        AND "reason" IN ('outcome_unknown', 'timeout', 'restart_post_action',
            'restart_client_accepted', 'restart_awaiting_confirmation')
        AND ("notBefore" IS NULL OR "notBefore" >= "openedAt")
    ),
    CONSTRAINT "MaxOutboundReconciliationTask_state_check" CHECK (
        "state" IN ('open', 'resolved', 'dead_letter')
        AND (("state" = 'open' AND "resolvedAt" IS NULL
                AND "resolutionType" IS NULL AND "resolutionEvidenceReference" IS NULL)
            OR ("state" IN ('resolved', 'dead_letter') AND "resolvedAt" IS NOT NULL
                AND "resolvedAt" >= "openedAt"
                AND "resolutionType" IN ('exact_provider_confirmation',
                    'provider_absence_proven', 'operator_dead_letter')
                AND "resolutionEvidenceReference" IS NOT NULL
                AND char_length("resolutionEvidenceReference") BETWEEN 1 AND 512
                AND "resolutionEvidenceReference" = btrim("resolutionEvidenceReference")
                AND "resolutionEvidenceReference" !~ '[[:cntrl:]]'
                AND "resolutionEvidenceReference" !~* '^(https?|wss?)://'))
    )
);

CREATE UNIQUE INDEX "MaxOutboundDispatch_command_key" ON "MaxOutboundDispatch"("commandId");
CREATE UNIQUE INDEX "MaxOutboundDispatch_reservation_key" ON "MaxOutboundDispatch"("reservationId");
CREATE UNIQUE INDEX "MaxOutboundDispatch_account_conversation_sequence_key"
ON "MaxOutboundDispatch"("accountId", "conversationKey", "commandSequence");
CREATE UNIQUE INDEX "MaxOutboundDispatch_account_conversation_dispatch_key"
ON "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId");
CREATE UNIQUE INDEX "MaxOutboundDispatch_command_identity_key"
ON "MaxOutboundDispatch"("accountId", "conversationKey", "commandId", "commandSequence");
CREATE UNIQUE INDEX "MaxOutboundDispatch_reservation_identity_key"
ON "MaxOutboundDispatch"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence");
CREATE UNIQUE INDEX "MaxOutboundDispatch_account_provider_message_key"
ON "MaxOutboundDispatch"("accountId", "providerMessageId") WHERE "providerMessageId" IS NOT NULL;
CREATE INDEX "MaxOutboundDispatch_account_conversation_state_sequence_idx"
ON "MaxOutboundDispatch"("accountId", "conversationKey", "state", "commandSequence");
CREATE INDEX "MaxOutboundDispatch_state_reconciliation_idx"
ON "MaxOutboundDispatch"("state", "reconciliationRequiredAt");

CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_dispatch_number_key"
ON "MaxOutboundDispatchAttempt"("dispatchId", "attemptNumber");
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_account_dispatch_correlation_key"
ON "MaxOutboundDispatchAttempt"("accountId", "dispatchId", "attemptCorrelationId");
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_account_conversation_attempt_key"
ON "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId");
CREATE UNIQUE INDEX "MaxOutboundDispatchAttempt_active_dispatch_key"
ON "MaxOutboundDispatchAttempt"("dispatchId") WHERE "completedAt" IS NULL;
CREATE INDEX "MaxOutboundDispatchAttempt_state_claim_idx"
ON "MaxOutboundDispatchAttempt"("attemptState", "claimUntil");
CREATE INDEX "MaxOutboundDispatchAttempt_account_conversation_state_idx"
ON "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptState");

CREATE UNIQUE INDEX "MaxOutboundDispatchTransition_dispatch_sequence_key"
ON "MaxOutboundDispatchTransition"("dispatchId", "transitionSequence");
CREATE UNIQUE INDEX "MaxOutboundDispatchTransition_idempotency_key"
ON "MaxOutboundDispatchTransition"("accountId", "dispatchId", "transitionIdempotencyKey");
CREATE INDEX "MaxOutboundDispatchTransition_account_conversation_occurred_idx"
ON "MaxOutboundDispatchTransition"("accountId", "conversationKey", "occurredAt");
CREATE INDEX "MaxOutboundDispatchTransition_attempt_idx"
ON "MaxOutboundDispatchTransition"("attemptId");

CREATE UNIQUE INDEX "MaxOutboundReconciliationTask_open_dispatch_key"
ON "MaxOutboundReconciliationTask"("dispatchId") WHERE "state" = 'open';
CREATE INDEX "MaxOutboundReconciliationTask_state_not_before_idx"
ON "MaxOutboundReconciliationTask"("state", "notBefore", "openedAt");
CREATE INDEX "MaxOutboundReconciliationTask_account_conversation_state_idx"
ON "MaxOutboundReconciliationTask"("accountId", "conversationKey", "state");

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_key"
ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "dispatchId");
CREATE UNIQUE INDEX "MaxOutboundCommandReservation_dispatch_partial_key"
ON "MaxOutboundCommandReservation"("accountId", "dispatchId") WHERE "dispatchId" IS NOT NULL;

ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_account_conversation_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_command_fkey"
FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence")
REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxOutboundDispatch" ADD CONSTRAINT "MaxOutboundDispatch_reservation_fkey"
FOREIGN KEY ("accountId", "conversationKey", "reservationId", "commandId", "commandSequence")
REFERENCES "MaxOutboundCommandReservation"("accountId", "conversationKey", "reservationId", "commandId", "commandSequence")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundDispatchLane" ADD CONSTRAINT "MaxOutboundDispatchLane_account_conversation_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundDispatchAttempt" ADD CONSTRAINT "MaxOutboundDispatchAttempt_dispatch_fkey"
FOREIGN KEY ("accountId", "conversationKey", "dispatchId")
REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_dispatch_fkey"
FOREIGN KEY ("accountId", "conversationKey", "dispatchId")
REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxOutboundDispatchTransition" ADD CONSTRAINT "MaxOutboundDispatchTransition_attempt_fkey"
FOREIGN KEY ("accountId", "conversationKey", "attemptId")
REFERENCES "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_dispatch_fkey"
FOREIGN KEY ("accountId", "conversationKey", "dispatchId")
REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "MaxOutboundReconciliationTask" ADD CONSTRAINT "MaxOutboundReconciliationTask_attempt_fkey"
FOREIGN KEY ("accountId", "conversationKey", "attemptId")
REFERENCES "MaxOutboundDispatchAttempt"("accountId", "conversationKey", "attemptId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundCommandReservation" ADD CONSTRAINT "MaxOutboundCommandReservation_dispatch_fkey"
FOREIGN KEY ("accountId", "conversationKey", "dispatchId")
REFERENCES "MaxOutboundDispatch"("accountId", "conversationKey", "dispatchId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundCommandReservation"
DROP CONSTRAINT "MaxOutboundCommandReservation_transition_fields_check";
ALTER TABLE "MaxOutboundCommandReservation"
ADD CONSTRAINT "MaxOutboundCommandReservation_transition_fields_check" CHECK (
    ("reservationState" = 'reserved' AND "releasedAt" IS NULL
        AND "handoffReference" IS NULL AND "handedOffAt" IS NULL AND "dispatchId" IS NULL)
    OR ("reservationState" IN ('released', 'expired')
        AND "releasedAt" IS NOT NULL AND "releasedAt" >= "reservedAt"
        AND "handoffReference" IS NULL AND "handedOffAt" IS NULL AND "dispatchId" IS NULL)
    OR ("reservationState" = 'handed_off' AND "releasedAt" IS NULL
        AND "dispatchId" IS NOT NULL AND "handoffReference" = "dispatchId"
        AND char_length("dispatchId") BETWEEN 1 AND 256
        AND "dispatchId" = btrim("dispatchId") AND "dispatchId" !~ '[[:cntrl:]]'
        AND "handedOffAt" IS NOT NULL AND "handedOffAt" >= "reservedAt")
);

-- Dispatch identity, immutable command linkage and initial route evidence cannot change.
-- No session setting or caller-controlled GUC is consulted.
CREATE FUNCTION "max_outbound_dispatch_immutable_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxOutboundDispatch_immutable"
BEFORE UPDATE ON "MaxOutboundDispatch"
FOR EACH ROW EXECUTE FUNCTION "max_outbound_dispatch_immutable_guard"();

CREATE FUNCTION "max_outbound_dispatch_attempt_immutable_guard"()
RETURNS trigger AS $$
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
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxOutboundDispatchAttempt_immutable"
BEFORE UPDATE ON "MaxOutboundDispatchAttempt"
FOR EACH ROW EXECUTE FUNCTION "max_outbound_dispatch_attempt_immutable_guard"();

CREATE FUNCTION "max_outbound_dispatch_transition_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxOutboundDispatchTransition is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "MaxOutboundDispatchTransition_append_only"
BEFORE UPDATE OR DELETE ON "MaxOutboundDispatchTransition"
FOR EACH ROW EXECUTE FUNCTION "max_outbound_dispatch_transition_append_only_guard"();

-- Rollback requires a separately approved retention-aware additive migration.
