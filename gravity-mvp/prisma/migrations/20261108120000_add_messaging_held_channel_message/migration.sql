-- Messaging-owned durable hold for the guarded atomic append (R-21).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery; production deployment remains a separate reviewed operation.
-- It adds one new Messaging-owned table and names, changes or removes no
-- existing object except the new foreign key's reference to "Chat".
--
-- One row is one provider event whose sender did not prove its conversation's
-- person binding. senderContactIdentityId is the proven sender identity the
-- event was held with (equal to holdEvidence by CHECK), so a release never
-- moves another identity's event into the proven person's conversation. It is durable, so the event is not lost, and it lives outside
-- "Message", so no conversation view, inbox, AI context or workflow can show it
-- in another person's conversation. A guarded release under a fresh proof moves
-- it into "Message" and stamps releasedAt/releasedMessageId; nothing else
-- updates it, and a released row keeps no content and no metadata (the visible
-- "Message" is its only copy; the released-scrubbed CHECK pins it). Deleting the
-- conversation deletes its held events (CASCADE), so a hold never outlives
-- conversation retention. The table stores no credential
-- and no Contact or Driver row; holdEvidence carries only the identifiers that
-- were compared and the bounded refusal code.

BEGIN;

CREATE TABLE "HeldChannelMessage" (
    "id" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "channel" "ChatChannel" NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "type" "MessageType" NOT NULL DEFAULT 'text',
    "content" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "holdReason" TEXT NOT NULL,
    "senderContactIdentityId" TEXT,
    "holdEvidence" JSONB NOT NULL DEFAULT '{}',
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "releasedAt" TIMESTAMP(3),
    "releasedMessageId" TEXT,

    CONSTRAINT "HeldChannelMessage_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "HeldChannelMessage_direction_check"
        CHECK ("direction" IN ('inbound', 'outbound')),
    CONSTRAINT "HeldChannelMessage_holdReason_check"
        CHECK ("holdReason" IN ('binding_absent', 'binding_mismatch', 'attribution_unproven', 'group_person_bound')),
    CONSTRAINT "HeldChannelMessage_release_pair_check"
        CHECK (("releasedAt" IS NULL) = ("releasedMessageId" IS NULL)),
    CONSTRAINT "HeldChannelMessage_sender_evidence_check"
        CHECK (
            ("senderContactIdentityId" IS NULL AND ("holdEvidence" #>> '{attribution,status}') IS DISTINCT FROM 'proven')
            OR ("senderContactIdentityId" IS NOT NULL
                AND ("holdEvidence" #>> '{attribution,status}') IS NOT DISTINCT FROM 'proven'
                AND "senderContactIdentityId" IS NOT DISTINCT FROM ("holdEvidence" #>> '{attribution,contactIdentityId}'))
        ),
    CONSTRAINT "HeldChannelMessage_released_scrubbed_check"
        CHECK ("releasedAt" IS NULL OR ("content" = '' AND "metadata" = '{}'::jsonb))
);

CREATE UNIQUE INDEX "HeldChannelMessage_externalId_key" ON "HeldChannelMessage"("externalId");

CREATE UNIQUE INDEX "HeldChannelMessage_releasedMessageId_key" ON "HeldChannelMessage"("releasedMessageId");

CREATE INDEX "HeldChannelMessage_chatId_releasedAt_sentAt_idx" ON "HeldChannelMessage"("chatId", "releasedAt", "sentAt");

CREATE INDEX "HeldChannelMessage_releasedAt_holdReason_idx" ON "HeldChannelMessage"("releasedAt", "holdReason");

ALTER TABLE "HeldChannelMessage" ADD CONSTRAINT "HeldChannelMessage_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
