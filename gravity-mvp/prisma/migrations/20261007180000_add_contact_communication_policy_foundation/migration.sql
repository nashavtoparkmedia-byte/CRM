-- Contacts-owned communication restriction foundation (Contact Identity epic,
-- contact communication restrictions foundation slice).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery; production deployment remains a separate reviewed operation.
-- It adds two new Contacts-owned tables with their constraints and guard
-- triggers. The only existing object it names is "Contact"("id"), as the
-- referenced side of two cascading foreign keys: no existing row is changed or
-- removed, and a Contact without a policy row stays exactly as permitted as it
-- is today. Nothing here stores a credential, a provider identifier, a
-- transport, a conversation or a channel identity.

BEGIN;

-- CreateTable
CREATE TABLE "ContactCommunicationPolicy" (
    "contactId" TEXT NOT NULL,
    "denyAll" BOOLEAN NOT NULL DEFAULT false,
    "denyMessage" BOOLEAN NOT NULL DEFAULT false,
    "denyVoice" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL,
    "updatedBy" VARCHAR(128) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactCommunicationPolicy_pkey" PRIMARY KEY ("contactId")
);

-- CreateTable
CREATE TABLE "ContactCommunicationPolicyEvent" (
    "eventId" VARCHAR(64) NOT NULL,
    "contactId" TEXT NOT NULL,
    "cause" VARCHAR(32) NOT NULL,
    "version" INTEGER NOT NULL,
    "previousVersion" INTEGER,
    "beforeDenyAll" BOOLEAN,
    "beforeDenyMessage" BOOLEAN,
    "beforeDenyVoice" BOOLEAN,
    "afterDenyAll" BOOLEAN NOT NULL,
    "afterDenyMessage" BOOLEAN NOT NULL,
    "afterDenyVoice" BOOLEAN NOT NULL,
    "actor" VARCHAR(128) NOT NULL,
    "reason" VARCHAR(512) NOT NULL,
    "mutationRequestId" VARCHAR(128),
    "requestDigest" VARCHAR(64),
    "mergeId" VARCHAR(64),
    "sourceContactId" TEXT,
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContactCommunicationPolicyEvent_pkey" PRIMARY KEY ("eventId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ContactCommunicationPolicyEvent_mutationRequestId_key" ON "ContactCommunicationPolicyEvent"("mutationRequestId");

-- CreateIndex
CREATE INDEX "ContactCommunicationPolicyEvent_contactId_recordedAt_idx" ON "ContactCommunicationPolicyEvent"("contactId", "recordedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContactCommunicationPolicyEvent_contactId_version_key" ON "ContactCommunicationPolicyEvent"("contactId", "version");

-- AddForeignKey
ALTER TABLE "ContactCommunicationPolicy" ADD CONSTRAINT "ContactCommunicationPolicy_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContactCommunicationPolicyEvent" ADD CONSTRAINT "ContactCommunicationPolicyEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Contract.
--
-- One logical policy per canonical Contact. The absence of a row means
-- allowed; a row carries exactly the three V1 flags, a version that advances
-- by one on every write and who wrote it. The policy is Contacts-owned state:
-- nothing in Contact.customFields is policy authority.
--
-- Every write of the policy row leaves one event: the cause (an operator
-- mutation, a merge composition, or a merge recovery), the before and after
-- flags, the version chain, the actor and the reason. For a mutation the event
-- also carries the deterministic request id and a digest of the request
-- semantics, which is what makes a repeated request a replay and a reused id
-- with a different payload a conflict. For a merge or a merge recovery it
-- carries the merge record id and the merged-away Contact instead.
--
-- Events are append-only evidence. They cannot be updated and they cannot be
-- deleted directly. The only permitted row removal, for either table, is the
-- cascade of the owning Contact row: that is how Contacts retention already
-- removes a Contact's identities and phones, and it is why no TRUNCATE guard is
-- installed here — both tables are ON DELETE CASCADE children of "Contact", and
-- a statement-level trigger cannot tell a cascaded TRUNCATE from a direct one.
-- ---------------------------------------------------------------------------

ALTER TABLE "ContactCommunicationPolicy" ADD CONSTRAINT "ContactCommunicationPolicy_shape_check" CHECK (
    "version" >= 1
    AND char_length("updatedBy") >= 1
    AND "updatedBy" = btrim("updatedBy")
    AND "updatedBy" !~ '[[:cntrl:]]'
);

ALTER TABLE "ContactCommunicationPolicyEvent" ADD CONSTRAINT "ContactCommunicationPolicyEvent_shape_check" CHECK (
    char_length("eventId") >= 1
    AND "eventId" = btrim("eventId")
    AND "eventId" !~ '[[:cntrl:]]'
    AND "cause" IN ('mutation', 'merge', 'merge_recovery')
    AND "version" >= 1
    AND char_length("actor") >= 1
    AND "actor" = btrim("actor")
    AND "actor" !~ '[[:cntrl:]]'
    AND char_length("reason") >= 1
    AND "reason" = btrim("reason")
    AND "reason" !~ '[[:cntrl:]]'
);

-- The version chain of one Contact is gapless: the first event is version 1
-- with no predecessor, and every later event names exactly the version before it.
ALTER TABLE "ContactCommunicationPolicyEvent" ADD CONSTRAINT "ContactCommunicationPolicyEvent_version_chain_check" CHECK (
    ("previousVersion" IS NULL AND "version" = 1)
    OR ("previousVersion" IS NOT NULL AND "previousVersion" = "version" - 1)
);

-- The before-state is recorded exactly when a previous version existed.
ALTER TABLE "ContactCommunicationPolicyEvent" ADD CONSTRAINT "ContactCommunicationPolicyEvent_before_state_check" CHECK (
    ("previousVersion" IS NULL) = ("beforeDenyAll" IS NULL)
    AND ("previousVersion" IS NULL) = ("beforeDenyMessage" IS NULL)
    AND ("previousVersion" IS NULL) = ("beforeDenyVoice" IS NULL)
);

-- A mutation carries its request identity and nothing about a merge; a merge or
-- a merge recovery carries its merge identity and the merged-away Contact.
ALTER TABLE "ContactCommunicationPolicyEvent" ADD CONSTRAINT "ContactCommunicationPolicyEvent_cause_shape_check" CHECK (
    ("mutationRequestId" IS NOT NULL) = ("cause" = 'mutation')
    AND ("requestDigest" IS NOT NULL) = ("cause" = 'mutation')
    AND ("mergeId" IS NOT NULL) = ("cause" <> 'mutation')
    AND ("sourceContactId" IS NOT NULL) = ("cause" <> 'mutation')
    AND (
        "mutationRequestId" IS NULL
        OR (
            char_length("mutationRequestId") >= 1
            AND "mutationRequestId" = btrim("mutationRequestId")
            AND "mutationRequestId" !~ '[[:cntrl:]]'
        )
    )
    AND ("requestDigest" IS NULL OR "requestDigest" ~ '^[0-9a-f]{64}$')
    AND (
        "mergeId" IS NULL
        OR (
            char_length("mergeId") >= 1
            AND "mergeId" = btrim("mergeId")
            AND "mergeId" !~ '[[:cntrl:]]'
        )
    )
    AND ("sourceContactId" IS NULL OR "sourceContactId" <> "contactId")
);

CREATE FUNCTION "contact_communication_policy_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'ContactCommunicationPolicy guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
        -- A standing restriction is never dropped by a direct statement. The only
        -- permitted removal is the cascade of the owning Contact row, which reaches
        -- this guard from inside the referential action rather than directly.
        IF pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'ContactCommunicationPolicy rows cannot be deleted directly';
        END IF;
        RETURN OLD;
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."version" <> 1 THEN
            RAISE EXCEPTION 'ContactCommunicationPolicy starts at version 1';
        END IF;
        NEW."createdAt" := now();
        NEW."updatedAt" := now();
        RETURN NEW;
    END IF;
    IF NEW."contactId" IS DISTINCT FROM OLD."contactId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'ContactCommunicationPolicy identity is immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'ContactCommunicationPolicy version must advance by exactly one per write';
    END IF;
    NEW."updatedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ContactCommunicationPolicy_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ContactCommunicationPolicy"
FOR EACH ROW EXECUTE FUNCTION "contact_communication_policy_guard"();

CREATE FUNCTION "contact_communication_policy_event_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'ContactCommunicationPolicyEvent guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'ContactCommunicationPolicyEvent rows are append-only evidence and cannot be updated';
    END IF;
    IF TG_OP = 'DELETE' THEN
        IF pg_trigger_depth() <= 1 THEN
            RAISE EXCEPTION 'ContactCommunicationPolicyEvent rows are append-only evidence and cannot be deleted directly';
        END IF;
        RETURN OLD;
    END IF;
    NEW."recordedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "ContactCommunicationPolicyEvent_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "ContactCommunicationPolicyEvent"
FOR EACH ROW EXECUTE FUNCTION "contact_communication_policy_event_guard"();

COMMIT;
