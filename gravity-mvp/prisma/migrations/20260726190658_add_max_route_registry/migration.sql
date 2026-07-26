-- Stage 2: additive, account-scoped MAX Route Registry foundation.
-- Review artifact only: Stage 2 does not apply this migration to any database.

CREATE UNIQUE INDEX "MaxRawTransportEvent_accountId_observationId_key"
ON "MaxRawTransportEvent"("accountId", "observationId");

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
    CONSTRAINT "MaxRouteConversation_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaxRouteConversation_state_check"
        CHECK ("state" IN ('unresolved', 'active', 'conflicted', 'retired')),
    CONSTRAINT "MaxRouteConversation_versions_check"
        CHECK ("routeVersion" >= 0 AND "optimisticVersion" >= 0),
    CONSTRAINT "MaxRouteConversation_account_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128 AND "accountId" = btrim("accountId")),
    CONSTRAINT "MaxRouteConversation_key_check"
        CHECK (char_length("conversationKey") BETWEEN 1 AND 256
            AND "conversationKey" = btrim("conversationKey")
            AND "conversationKey" !~ '[[:cntrl:]]'),
    CONSTRAINT "MaxRouteConversation_retirement_audit_check"
        CHECK (("state" <> 'retired' AND "retiredAt" IS NULL AND "retiredBy" IS NULL AND "retirementReason" IS NULL)
            OR ("state" = 'retired' AND "retiredAt" IS NOT NULL
                AND char_length("retiredBy") > 0 AND char_length("retirementReason") > 0))
);

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
    CONSTRAINT "MaxRouteIdentityBinding_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MaxRouteIdentityBinding_kind_check"
        CHECK ("identityKind" IN ('provider_user_id', 'protocol_chat_id', 'web_route_id')),
    CONSTRAINT "MaxRouteIdentityBinding_status_check"
        CHECK ("status" IN ('provisional', 'active', 'superseded', 'conflicted')),
    CONSTRAINT "MaxRouteIdentityBinding_value_check"
        CHECK (char_length("identityValue") BETWEEN 1 AND 512
            AND "identityValue" = btrim("identityValue")
            AND "identityValue" !~ '[[:cntrl:]]'),
    CONSTRAINT "MaxRouteIdentityBinding_version_check" CHECK ("version" >= 0),
    CONSTRAINT "MaxRouteIdentityBinding_account_time_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128
            AND "accountId" = btrim("accountId") AND "lastSeenAt" >= "firstSeenAt")
);

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
    CONSTRAINT "MaxRouteObservation_pkey" PRIMARY KEY ("routeObservationId"),
    CONSTRAINT "MaxRouteObservation_kind_check"
        CHECK ("identityKind" IN ('provider_user_id', 'protocol_chat_id', 'web_route_id')),
    CONSTRAINT "MaxRouteObservation_authority_check"
        CHECK ("evidenceAuthority" IN ('protocol_exact', 'provider_exact', 'web_route_observed', 'legacy_import', 'manual_approved')),
    CONSTRAINT "MaxRouteObservation_result_check"
        CHECK ("processingResult" IN ('created', 'confirmed', 'attached', 'provisional', 'conflict', 'requires_supersede', 'ignored_weak', 'superseded', 'retired')),
    CONSTRAINT "MaxRouteObservation_size_version_check"
        CHECK ("evidenceSizeBytes" >= 0 AND ("routeVersionAfter" IS NULL OR "routeVersionAfter" >= 0)),
    CONSTRAINT "MaxRouteObservation_account_hash_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128 AND "accountId" = btrim("accountId")
            AND "idempotencyKey" ~ '^[0-9a-f]{64}$' AND "evidenceSha256" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "MaxRouteObservation_identity_value_check"
        CHECK (char_length("identityValue") BETWEEN 1 AND 512
            AND "identityValue" = btrim("identityValue")
            AND "identityValue" !~ '[[:cntrl:]]')
);

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
    CONSTRAINT "MaxRouteConflict_pkey" PRIMARY KEY ("conflictId"),
    CONSTRAINT "MaxRouteConflict_kind_check"
        CHECK ("identityKind" IN ('provider_user_id', 'protocol_chat_id', 'web_route_id')),
    CONSTRAINT "MaxRouteConflict_status_check"
        CHECK ("status" IN ('open', 'resolved', 'dismissed')),
    CONSTRAINT "MaxRouteConflict_versions_check"
        CHECK ("expectedRouteVersion" >= 0 AND "version" >= 0),
    CONSTRAINT "MaxRouteConflict_account_check"
        CHECK (char_length("accountId") BETWEEN 1 AND 128 AND "accountId" = btrim("accountId")),
    CONSTRAINT "MaxRouteConflict_resolution_audit_check"
        CHECK (("status" = 'open' AND "resolvedAt" IS NULL AND "resolutionReason" IS NULL
                AND "resolvedBy" IS NULL AND "auditMetadata" IS NULL)
            OR ("status" IN ('resolved', 'dismissed') AND "resolvedAt" IS NOT NULL
                AND char_length("resolutionReason") > 0 AND char_length("resolvedBy") > 0
                AND "auditMetadata" IS NOT NULL))
);

CREATE UNIQUE INDEX "MaxRouteConversation_accountId_conversationKey_key"
ON "MaxRouteConversation"("accountId", "conversationKey");
CREATE INDEX "MaxRouteConversation_accountId_state_idx"
ON "MaxRouteConversation"("accountId", "state");
CREATE INDEX "MaxRouteConversation_accountId_routeVersion_idx"
ON "MaxRouteConversation"("accountId", "routeVersion");

CREATE UNIQUE INDEX "MaxRouteIdentityBinding_accountId_identityKind_identityValu_key"
ON "MaxRouteIdentityBinding"("accountId", "identityKind", "identityValue");
CREATE UNIQUE INDEX "MaxRouteIdentityBinding_one_active_kind_per_conversation_key"
ON "MaxRouteIdentityBinding"("accountId", "conversationKey", "identityKind")
WHERE "status" = 'active';
CREATE INDEX "MaxRouteIdentityBinding_accountId_conversationKey_status_idx"
ON "MaxRouteIdentityBinding"("accountId", "conversationKey", "status");
CREATE INDEX "MaxRouteIdentityBinding_accountId_identityKind_status_idx"
ON "MaxRouteIdentityBinding"("accountId", "identityKind", "status");

CREATE UNIQUE INDEX "MaxRouteObservation_accountId_idempotencyKey_key"
ON "MaxRouteObservation"("accountId", "idempotencyKey");
CREATE UNIQUE INDEX "MaxRouteObservation_accountId_routeObservationId_key"
ON "MaxRouteObservation"("accountId", "routeObservationId");
CREATE INDEX "MaxRouteObservation_sourceRawObservationId_idx"
ON "MaxRouteObservation"("sourceRawObservationId");
CREATE INDEX "MaxRouteObservation_accountId_observedAt_idx"
ON "MaxRouteObservation"("accountId", "observedAt");
CREATE INDEX "MaxRouteObservation_accountId_candidateConversationKey_idx"
ON "MaxRouteObservation"("accountId", "candidateConversationKey");

CREATE UNIQUE INDEX "MaxRouteConflict_accountId_sourceRouteObservationId_key"
ON "MaxRouteConflict"("accountId", "sourceRouteObservationId");
CREATE INDEX "MaxRouteConflict_accountId_status_createdAt_idx"
ON "MaxRouteConflict"("accountId", "status", "createdAt");
CREATE INDEX "MaxRouteConflict_accountId_identityKind_identityValue_statu_idx"
ON "MaxRouteConflict"("accountId", "identityKind", "identityValue", "status");
CREATE UNIQUE INDEX "MaxRouteConflict_one_open_identity_route_pair_key"
ON "MaxRouteConflict"(
    "accountId", "identityKind", "identityValue",
    "incumbentConversationKey", "candidateConversationKey"
)
WHERE "status" = 'open';
CREATE INDEX "MaxRouteConflict_accountId_incumbentConversationKey_status_idx"
ON "MaxRouteConflict"("accountId", "incumbentConversationKey", "status");
CREATE INDEX "MaxRouteConflict_accountId_candidateConversationKey_status_idx"
ON "MaxRouteConflict"("accountId", "candidateConversationKey", "status");

ALTER TABLE "MaxRouteIdentityBinding"
ADD CONSTRAINT "MaxRouteIdentityBinding_accountId_conversationKey_fkey"
FOREIGN KEY ("accountId", "conversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxRouteObservation"
ADD CONSTRAINT "MaxRouteObservation_accountId_candidateConversationKey_fkey"
FOREIGN KEY ("accountId", "candidateConversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxRouteObservation"
ADD CONSTRAINT "MaxRouteObservation_accountId_sourceRawObservationId_fkey"
FOREIGN KEY ("accountId", "sourceRawObservationId")
REFERENCES "MaxRawTransportEvent"("accountId", "observationId")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxRouteConflict"
ADD CONSTRAINT "MaxRouteConflict_accountId_incumbentConversationKey_fkey"
FOREIGN KEY ("accountId", "incumbentConversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxRouteConflict"
ADD CONSTRAINT "MaxRouteConflict_accountId_candidateConversationKey_fkey"
FOREIGN KEY ("accountId", "candidateConversationKey")
REFERENCES "MaxRouteConversation"("accountId", "conversationKey")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "MaxRouteConflict"
ADD CONSTRAINT "MaxRouteConflict_accountId_sourceRouteObservationId_fkey"
FOREIGN KEY ("accountId", "sourceRouteObservationId")
REFERENCES "MaxRouteObservation"("accountId", "routeObservationId")
ON DELETE RESTRICT ON UPDATE CASCADE;

-- Route evidence is append-only. Future retention requires a separately
-- reviewed privileged database maintenance contract; caller settings are not
-- an authorization boundary.
CREATE FUNCTION "max_route_observation_append_only_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MaxRouteObservation is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxRouteObservation_append_only"
BEFORE UPDATE OR DELETE ON "MaxRouteObservation"
FOR EACH ROW EXECUTE FUNCTION "max_route_observation_append_only_guard"();

-- Rollback is never automatic. A separately approved follow-up migration must
-- first export or disposition route evidence/conflicts under retention policy,
-- then reverse foreign keys, trigger/function, indexes, and new tables.
