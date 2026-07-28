-- Next-release, additive shadow-only artifact. This migration is not part of
-- the accepted exact-eight Stage 8B2A list and performs no runtime enablement.
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
    CONSTRAINT "MaxOutboundShadowPlan_pkey" PRIMARY KEY ("planId"),
    CONSTRAINT "MaxOutboundShadowPlan_identity_check" CHECK (
        char_length("planId") BETWEEN 1 AND 256 AND "planId" = btrim("planId") AND "planId" !~ '[[:cntrl:]]'
        AND char_length("schemaVersion") BETWEEN 1 AND 128
        AND char_length("accountId") BETWEEN 1 AND 128 AND "accountId" = btrim("accountId") AND "accountId" <> '*'
        AND char_length("conversationKey") BETWEEN 1 AND 256 AND "conversationKey" = btrim("conversationKey")
        AND char_length("reservationId") BETWEEN 1 AND 256 AND "reservationId" = btrim("reservationId")
        AND char_length("attemptCorrelationId") BETWEEN 1 AND 256 AND "attemptCorrelationId" = btrim("attemptCorrelationId")
        AND char_length("idempotencyKey") BETWEEN 1 AND 256 AND "idempotencyKey" = btrim("idempotencyKey")
    ),
    CONSTRAINT "MaxOutboundShadowPlan_hash_sequence_check" CHECK (
        "inputSha256" ~ '^[0-9a-f]{64}$' AND "accountAliasSha256" ~ '^[0-9a-f]{64}$'
        AND "conversationKeySha256" ~ '^[0-9a-f]{64}$' AND "payloadSha256" ~ '^[0-9a-f]{64}$'
        AND "commandSequence" > 0 AND "payloadSizeBytes" BETWEEN 0 AND 65536
        AND ("routeVersion" IS NULL OR "routeVersion" >= 0)
        AND ("ownerFencingToken" IS NULL OR "ownerFencingToken" >= 1)
    ),
    CONSTRAINT "MaxOutboundShadowPlan_decision_check" CHECK (
        char_length("payloadKind") BETWEEN 1 AND 64 AND "replyMetadata" = 'none'
        AND (("wouldSend" = true AND "refusalReason" IS NULL)
          OR ("wouldSend" = false AND "refusalReason" IN (
            'ROUTE_NOT_FOUND', 'ROUTE_CONFLICT', 'ACCOUNT_MISMATCH', 'CONVERSATION_NOT_SENDABLE',
            'OWNER_NOT_ACQUIRED', 'OWNER_LEASE_EXPIRED', 'FENCING_TOKEN_MISSING', 'FENCING_TOKEN_STALE',
            'PAYLOAD_UNSUPPORTED', 'COMMAND_ALREADY_TERMINAL', 'IDEMPOTENCY_CONFLICT'
          )))
        AND jsonb_typeof("semanticComparison") = 'object'
    )
);

CREATE UNIQUE INDEX "MaxOutboundShadowPlan_command_key" ON "MaxOutboundShadowPlan"("commandId");
CREATE UNIQUE INDEX "MaxOutboundShadowPlan_account_idempotency_key" ON "MaxOutboundShadowPlan"("accountId", "idempotencyKey");
CREATE INDEX "MaxOutboundShadowPlan_account_conversation_sequence_idx" ON "MaxOutboundShadowPlan"("accountId", "conversationKey", "commandSequence");
CREATE INDEX "MaxOutboundShadowPlan_account_decision_idx" ON "MaxOutboundShadowPlan"("accountId", "wouldSend", "refusalReason");

ALTER TABLE "MaxOutboundShadowPlan"
ADD CONSTRAINT "MaxOutboundShadowPlan_command_fkey"
FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence")
REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "max_outbound_shadow_plan_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxOutboundShadowPlan is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxOutboundShadowPlan_append_only"
BEFORE UPDATE OR DELETE ON "MaxOutboundShadowPlan"
FOR EACH ROW EXECUTE FUNCTION "max_outbound_shadow_plan_append_only_guard"();

-- Rollback requires separate retention approval. No command, dispatch, delivery,
-- provider, route, reservation, or user-visible state is mutated here.
