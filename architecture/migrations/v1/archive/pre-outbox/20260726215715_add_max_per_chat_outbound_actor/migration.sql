-- Stage 4: additive durable per-conversation outbound actor foundation.
-- This migration is exercised only by the disposable gate in this stage.

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
    CONSTRAINT "MaxOutboundCommand_pkey" PRIMARY KEY ("commandId"),
    CONSTRAINT "MaxOutboundCommand_identity_check" CHECK (
        char_length("commandId") BETWEEN 1 AND 256
        AND "commandId" = btrim("commandId")
        AND "commandId" !~ '[[:cntrl:]]'
        AND char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND char_length("conversationKey") BETWEEN 1 AND 256
        AND "conversationKey" = btrim("conversationKey")
        AND "conversationKey" !~ '[[:cntrl:]]'
        AND ("clientMessageId" IS NULL OR (
            char_length("clientMessageId") BETWEEN 1 AND 256
            AND "clientMessageId" = btrim("clientMessageId")
            AND "clientMessageId" !~ '[[:cntrl:]]'))
    ),
    CONSTRAINT "MaxOutboundCommand_sequence_kind_check" CHECK (
        "commandSequence" > 0
        AND "commandKind" = 'text'
        AND char_length("envelopeVersion") BETWEEN 1 AND 128
        AND "envelopeVersion" = btrim("envelopeVersion")
        AND "source" IN ('gravity', 'api', 'replay', 'synthetic_test')
    ),
    CONSTRAINT "MaxOutboundCommand_payload_check" CHECK (
        "payloadSha256" ~ '^[0-9a-f]{64}$'
        AND pg_column_size("commandPayload") <= 131072
        AND jsonb_typeof("commandPayload") = 'object'
        AND "commandPayload"->>'kind' = 'text'
        AND jsonb_typeof("commandPayload"->'text') = 'string'
    )
);

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
    CONSTRAINT "MaxOutboundConversationActor_pkey" PRIMARY KEY ("accountId", "conversationKey"),
    CONSTRAINT "MaxOutboundConversationActor_sequence_check" CHECK (
        "nextCommandSequence" >= 0
        AND "nextHandoffSequence" >= 1
        AND "nextHandoffSequence" <= "nextCommandSequence" + 1
    ),
    CONSTRAINT "MaxOutboundConversationActor_lease_version_check" CHECK (
        "leaseEpoch" >= 0 AND "optimisticVersion" >= 0
        AND (("leaseOwnerId" IS NULL AND "leaseUntil" IS NULL)
            OR ("leaseOwnerId" IS NOT NULL AND "leaseUntil" IS NOT NULL
                AND char_length("leaseOwnerId") BETWEEN 1 AND 256
                AND "leaseOwnerId" = btrim("leaseOwnerId")
                AND "leaseOwnerId" !~ '[[:cntrl:]]'))
    )
);

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
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxOutboundCommandReservation_pkey" PRIMARY KEY ("reservationId"),
    CONSTRAINT "MaxOutboundCommandReservation_identity_check" CHECK (
        char_length("reservationId") BETWEEN 1 AND 256
        AND "reservationId" = btrim("reservationId")
        AND "reservationId" !~ '[[:cntrl:]]'
        AND char_length("leaseOwnerId") BETWEEN 1 AND 256
        AND "leaseOwnerId" = btrim("leaseOwnerId")
        AND "leaseOwnerId" !~ '[[:cntrl:]]'
        AND "commandSequence" > 0
        AND "leaseEpoch" >= 0
        AND "reservationVersion" >= 0
        AND "leaseUntil" > "reservedAt"
    ),
    CONSTRAINT "MaxOutboundCommandReservation_state_check" CHECK (
        "reservationState" IN ('reserved', 'released', 'handed_off', 'expired')
    ),
    CONSTRAINT "MaxOutboundCommandReservation_transition_fields_check" CHECK (
        ("reservationState" = 'reserved'
            AND "releasedAt" IS NULL AND "handoffReference" IS NULL AND "handedOffAt" IS NULL)
        OR ("reservationState" IN ('released', 'expired')
            AND "releasedAt" IS NOT NULL AND "releasedAt" >= "reservedAt"
            AND "handoffReference" IS NULL AND "handedOffAt" IS NULL)
        OR ("reservationState" = 'handed_off'
            AND "releasedAt" IS NULL
            AND "handoffReference" IS NOT NULL
            AND char_length("handoffReference") BETWEEN 1 AND 512
            AND "handoffReference" = btrim("handoffReference")
            AND "handoffReference" !~ '[[:cntrl:]]'
            AND "handedOffAt" IS NOT NULL AND "handedOffAt" >= "reservedAt")
    )
);

CREATE UNIQUE INDEX "MaxOutboundCommand_account_conversation_sequence_key"
ON "MaxOutboundCommand"("accountId", "conversationKey", "commandSequence");
CREATE UNIQUE INDEX "MaxOutboundCommand_account_conversation_command_sequence_key"
ON "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence");
CREATE UNIQUE INDEX "MaxOutboundCommand_account_client_message_key"
ON "MaxOutboundCommand"("accountId", "clientMessageId") WHERE "clientMessageId" IS NOT NULL;
CREATE INDEX "MaxOutboundCommand_account_conversation_created_idx"
ON "MaxOutboundCommand"("accountId", "conversationKey", "createdAt");

CREATE INDEX "MaxOutboundConversationActor_lease_until_idx"
ON "MaxOutboundConversationActor"("leaseUntil");

CREATE UNIQUE INDEX "MaxOutboundCommandReservation_active_command_key"
ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "commandId")
WHERE "reservationState" = 'reserved';
CREATE UNIQUE INDEX "MaxOutboundCommandReservation_active_conversation_key"
ON "MaxOutboundCommandReservation"("accountId", "conversationKey")
WHERE "reservationState" = 'reserved';
CREATE INDEX "MaxOutboundCommandReservation_state_lease_idx"
ON "MaxOutboundCommandReservation"("reservationState", "leaseUntil");
CREATE INDEX "MaxOutboundCommandReservation_account_conversation_sequence_idx"
ON "MaxOutboundCommandReservation"("accountId", "conversationKey", "commandSequence");

ALTER TABLE "MaxOutboundCommand"
ADD CONSTRAINT "MaxOutboundCommand_account_conversation_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundConversationActor"
ADD CONSTRAINT "MaxOutboundConversationActor_account_conversation_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundCommandReservation"
ADD CONSTRAINT "MaxOutboundCommandReservation_command_fkey"
FOREIGN KEY ("accountId", "conversationKey", "commandId", "commandSequence")
REFERENCES "MaxOutboundCommand"("accountId", "conversationKey", "commandId", "commandSequence")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxOutboundCommandReservation"
ADD CONSTRAINT "MaxOutboundCommandReservation_actor_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxOutboundConversationActor"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Immutable user send intent. No custom GUC/session flag can bypass this guard.
CREATE FUNCTION "max_outbound_command_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxOutboundCommand is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxOutboundCommand_append_only"
BEFORE UPDATE OR DELETE ON "MaxOutboundCommand"
FOR EACH ROW EXECUTE FUNCTION "max_outbound_command_append_only_guard"();

-- Rollback requires a separately approved retention-aware migration. Stage 4
-- never deletes immutable commands or interprets handed_off as provider state.
