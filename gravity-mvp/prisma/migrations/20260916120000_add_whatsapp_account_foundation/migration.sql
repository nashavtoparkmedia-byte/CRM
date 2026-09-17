-- WhatsApp Channel-owned company account foundation (M2A1-S1).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery goal; production deployment remains a separate reviewed
-- operation. It adds four new tables with their constraints and guard
-- triggers and touches no existing table: no existing row is changed or
-- backfilled, and no account or binding is derived from existing WhatsApp data.
--
-- Inert foundation. No runtime code reads or writes these tables. The capability
-- lease proves the database fencing rules only; it does not fence any live
-- WhatsApp transport.
--
-- Model. A WhatsApp account is a logical provider account identified by its
-- complete provider key set (PN user and LID user, exact provider form, no phone
-- normalization). A transport binding is attested history of one runtime slot
-- generation serving one account. Its verification evidence is that complete
-- key set: both provider values are stored on the binding and each is bound by
-- a composite foreign key to the key of its fixed kind owned by the same
-- account. Re-pairing opens a new binding on a strictly newer generation and
-- never redefines an old identity. Account lifecycle (operator intent) and binding
-- trust (attestation) are separate axes. Stale is derived from attestedUntil and
-- never stored. Pause, disable and history deletion are separate concepts; none
-- of them removes a row here.
--
-- Concurrency. Every guard on a lease or a binding locks the account row before
-- it reads across tables, and every guarded write requires READ COMMITTED, so a
-- cross-table rule cannot be beaten by concurrent transactions. A trigger can
-- lock the account row only after PostgreSQL has locked the lease or binding row
-- being written, so the writer lock order (the WhatsAppAccount row, then
-- WhatsAppCapabilityLease rows by capability, then WhatsAppTransportBinding
-- rows) holds only when a writer locks the account row itself first. A bare
-- single-statement write stays correct but can deadlock against an ordered
-- writer. Event times are stamped from the database clock. A lifecycle change,
-- an attestation and a lease write are refused from a transaction that started
-- before the latest lifecycle change, attestation or heartbeat on that row; an
-- attestation, a claim or an operator confirmation is never older than the
-- opening of its binding; a close is never older than the opening, attestation
-- or confirmation it ends; and a new binding is never older than its account or
-- its slot. Other recorded times are not compared with each other.

BEGIN;

-- CreateTable
CREATE TABLE "WhatsAppAccount" (
    "accountId" VARCHAR(64) NOT NULL,
    "accountKind" VARCHAR(32) NOT NULL,
    "lifecycle" VARCHAR(32) NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "lifecycleChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycleChangedBy" VARCHAR(128) NOT NULL,
    "lifecycleReason" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppAccount_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "WhatsAppAccountKey" (
    "keyKind" VARCHAR(32) NOT NULL,
    "keyValue" VARCHAR(128) NOT NULL,
    "accountId" VARCHAR(64) NOT NULL,
    "firstAttestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppAccountKey_pkey" PRIMARY KEY ("keyKind","keyValue")
);

-- CreateTable
CREATE TABLE "WhatsAppTransportBinding" (
    "bindingId" VARCHAR(64) NOT NULL,
    "transportKind" VARCHAR(32) NOT NULL,
    "transportRef" VARCHAR(128) NOT NULL,
    "transportGeneration" BIGINT NOT NULL,
    "accountId" VARCHAR(64) NOT NULL,
    "bindingSeq" INTEGER NOT NULL,
    "trustState" VARCHAR(16) NOT NULL,
    "attestationOrigin" VARCHAR(32) NOT NULL,
    "attestedPnKind" VARCHAR(32) NOT NULL DEFAULT 'whatsapp_pn_user',
    "attestedPnValue" VARCHAR(128),
    "attestedLidKind" VARCHAR(32) NOT NULL DEFAULT 'whatsapp_lid_user',
    "attestedLidValue" VARCHAR(128),
    "claimedPnValue" VARCHAR(128),
    "claimedLidValue" VARCHAR(128),
    "attestingInstanceId" VARCHAR(128) NOT NULL,
    "operatorConfirmedAt" TIMESTAMPTZ(3),
    "operatorConfirmedBy" VARCHAR(128),
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAttestedAt" TIMESTAMPTZ(3),
    "attestedUntil" TIMESTAMPTZ(3),
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" VARCHAR(32),

    CONSTRAINT "WhatsAppTransportBinding_pkey" PRIMARY KEY ("bindingId")
);

-- CreateTable
CREATE TABLE "WhatsAppCapabilityLease" (
    "accountId" VARCHAR(64) NOT NULL,
    "capability" VARCHAR(32) NOT NULL,
    "epoch" BIGINT NOT NULL,
    "version" BIGINT NOT NULL,
    "holderBindingId" VARCHAR(64) NOT NULL,
    "holderInstanceId" VARCHAR(128) NOT NULL,
    "state" VARCHAR(16) NOT NULL,
    "heartbeatAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseUntil" TIMESTAMPTZ(3) NOT NULL,
    "fenceUntil" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastReleasedAt" TIMESTAMPTZ(3),

    CONSTRAINT "WhatsAppCapabilityLease_pkey" PRIMARY KEY ("accountId","capability")
);

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccountKey_accountId_keyKind_key" ON "WhatsAppAccountKey"("accountId", "keyKind");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppAccountKey_keyKind_keyValue_accountId_key" ON "WhatsAppAccountKey"("keyKind", "keyValue", "accountId");

-- CreateIndex
CREATE INDEX "WhatsAppTransportBinding_accountId_idx" ON "WhatsAppTransportBinding"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTransportBinding_bindingId_accountId_key" ON "WhatsAppTransportBinding"("bindingId", "accountId");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTransportBinding_transportKind_transportRef_binding_key" ON "WhatsAppTransportBinding"("transportKind", "transportRef", "bindingSeq");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppTransportBinding_transportKind_transportRef_transpo_key" ON "WhatsAppTransportBinding"("transportKind", "transportRef", "transportGeneration");

-- CreateIndex
CREATE INDEX "WhatsAppCapabilityLease_holderBindingId_idx" ON "WhatsAppCapabilityLease"("holderBindingId");

-- AddForeignKey
ALTER TABLE "WhatsAppAccountKey" ADD CONSTRAINT "WhatsAppAccountKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attestedPnKind_attestedPnValue_ac_fkey" FOREIGN KEY ("attestedPnKind", "attestedPnValue", "accountId") REFERENCES "WhatsAppAccountKey"("keyKind", "keyValue", "accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attestedLidKind_attestedLidValue__fkey" FOREIGN KEY ("attestedLidKind", "attestedLidValue", "accountId") REFERENCES "WhatsAppAccountKey"("keyKind", "keyValue", "accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppCapabilityLease" ADD CONSTRAINT "WhatsAppCapabilityLease_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppCapabilityLease" ADD CONSTRAINT "WhatsAppCapabilityLease_holderBindingId_accountId_fkey" FOREIGN KEY ("holderBindingId", "accountId") REFERENCES "WhatsAppTransportBinding"("bindingId", "accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;


-- Value domains and cross-column rules
ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_identity_check" CHECK (
    char_length("accountId") >= 1
    AND "accountId" = btrim("accountId")
    AND "accountId" !~ '[[:cntrl:]]'
    AND "accountKind" = 'whatsapp_user'
);

ALTER TABLE "WhatsAppAccount" ADD CONSTRAINT "WhatsAppAccount_lifecycle_check" CHECK (
    "lifecycle" IN ('pending_approval', 'active', 'rejected', 'disabled', 'retired')
    AND "lifecycleVersion" >= 1
    AND char_length("lifecycleChangedBy") >= 1
    AND "lifecycleChangedBy" = btrim("lifecycleChangedBy")
    AND "lifecycleChangedBy" !~ '[[:cntrl:]]'
    AND char_length("lifecycleReason") >= 1
    AND "lifecycleReason" = btrim("lifecycleReason")
    AND "lifecycleReason" !~ '[[:cntrl:]]'
);

ALTER TABLE "WhatsAppAccountKey" ADD CONSTRAINT "WhatsAppAccountKey_value_check" CHECK (
    "keyKind" IN ('whatsapp_pn_user', 'whatsapp_lid_user')
    AND char_length("keyValue") >= 1
    AND "keyValue" = btrim("keyValue")
    AND "keyValue" !~ '[[:cntrl:]]'
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_shape_check" CHECK (
    char_length("bindingId") >= 1
    AND "bindingId" = btrim("bindingId")
    AND "bindingId" !~ '[[:cntrl:]]'
    AND "transportKind" = 'whatsapp_web_slot'
    AND char_length("transportRef") >= 1
    AND "transportRef" = btrim("transportRef")
    AND "transportRef" !~ '[[:cntrl:]]'
    AND "transportGeneration" >= 1
    AND "bindingSeq" >= 1
    AND "attestationOrigin" IN ('provider_verified', 'transport_asserted')
    AND char_length("attestingInstanceId") >= 1
    AND "attestingInstanceId" = btrim("attestingInstanceId")
    AND "attestingInstanceId" !~ '[[:cntrl:]]'
);

-- A close is never recorded as older than the opening, attestation or operator
-- confirmation it ends.
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_trust_check" CHECK (
    "trustState" IN ('pending', 'verified', 'mismatched', 'revoked', 'closed')
    AND ("closedAt" IS NULL) = ("trustState" IN ('pending', 'verified'))
    AND ("closedAt" IS NULL) = ("closeReason" IS NULL)
    AND (
        "closedAt" IS NULL
        OR (
            "closedAt" >= "openedAt"
            AND ("lastAttestedAt" IS NULL OR "closedAt" >= "lastAttestedAt")
            AND ("operatorConfirmedAt" IS NULL OR "closedAt" >= "operatorConfirmedAt")
        )
    )
    AND (
        "closeReason" IS NULL
        OR "closeReason" IN (
            'account_changed', 'credential_invalid', 'logged_out', 'revoked_by_operator',
            'transport_retired', 'superseded', 'duplicate_transport_conflict'
        )
    )
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_key_kind_check" CHECK (
    "attestedPnKind" = 'whatsapp_pn_user'
    AND "attestedLidKind" = 'whatsapp_lid_user'
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_claimed_key_check" CHECK (
    (
        "claimedPnValue" IS NULL
        OR (
            char_length("claimedPnValue") >= 1
            AND "claimedPnValue" = btrim("claimedPnValue")
            AND "claimedPnValue" !~ '[[:cntrl:]]'
        )
    )
    AND (
        "claimedLidValue" IS NULL
        OR (
            char_length("claimedLidValue") >= 1
            AND "claimedLidValue" = btrim("claimedLidValue")
            AND "claimedLidValue" !~ '[[:cntrl:]]'
        )
    )
    AND (
        "attestationOrigin" <> 'transport_asserted'
        OR "claimedPnValue" IS NOT NULL
        OR "claimedLidValue" IS NOT NULL
    )
    AND (
        "attestationOrigin" <> 'transport_asserted'
        OR (
            ("attestedPnValue" IS NULL OR "attestedPnValue" IS NOT DISTINCT FROM "claimedPnValue")
            AND ("attestedLidValue" IS NULL OR "attestedLidValue" IS NOT DISTINCT FROM "claimedLidValue")
        )
    )
    AND (
        "attestationOrigin" <> 'transport_asserted'
        OR "operatorConfirmedAt" IS NULL
        OR ("claimedPnValue" IS NOT NULL AND "claimedLidValue" IS NOT NULL)
    )
    AND (
        "trustState" <> 'verified'
        OR (
            ("claimedPnValue" IS NULL OR "claimedPnValue" = "attestedPnValue")
            AND ("claimedLidValue" IS NULL OR "claimedLidValue" = "attestedLidValue")
        )
    )
);

-- Attested provider values are recorded only as a complete pair and only
-- together with an attestation window, so one attestation always carries
-- both halves; a lone PN or LID can only be held as a claim.
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attested_key_pair_check" CHECK (
    ("attestedPnValue" IS NULL) = ("attestedLidValue" IS NULL)
    AND ("attestedPnValue" IS NULL OR "attestedUntil" IS NOT NULL)
);

-- A verified binding carries the complete provider key set. Each value is
-- proven against the account by its own composite foreign key above.
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_verified_key_set_check" CHECK (
    "trustState" <> 'verified'
    OR (
        "attestedPnValue" IS NOT NULL
        AND "attestedLidValue" IS NOT NULL
    )
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attestation_check" CHECK (
    ("attestedUntil" IS NULL) = ("lastAttestedAt" IS NULL)
    AND (
        "attestedUntil" IS NULL
        OR ("attestedUntil" > "lastAttestedAt" AND "attestedUntil" <= "lastAttestedAt" + interval '1 hour')
    )
    AND ("trustState" <> 'verified' OR "attestedUntil" IS NOT NULL)
    AND ("lastAttestedAt" IS NULL OR "lastAttestedAt" >= "openedAt")
    AND ("operatorConfirmedAt" IS NULL OR "operatorConfirmedAt" >= "openedAt")
    AND ("operatorConfirmedAt" IS NULL) = ("operatorConfirmedBy" IS NULL)
    AND (
        "operatorConfirmedBy" IS NULL
        OR (
            char_length("operatorConfirmedBy") >= 1
            AND "operatorConfirmedBy" = btrim("operatorConfirmedBy")
            AND "operatorConfirmedBy" !~ '[[:cntrl:]]'
        )
    )
    AND NOT (
        "trustState" = 'verified'
        AND "attestationOrigin" = 'transport_asserted'
        AND "operatorConfirmedAt" IS NULL
    )
);

ALTER TABLE "WhatsAppCapabilityLease" ADD CONSTRAINT "WhatsAppCapabilityLease_shape_check" CHECK (
    "capability" IN ('inbound', 'outbound', 'history_import')
    AND "state" IN ('held', 'released')
    AND "epoch" >= 1
    AND "version" >= 1
    AND char_length("holderInstanceId") >= 1
    AND "holderInstanceId" = btrim("holderInstanceId")
    AND "holderInstanceId" !~ '[[:cntrl:]]'
);

ALTER TABLE "WhatsAppCapabilityLease" ADD CONSTRAINT "WhatsAppCapabilityLease_time_check" CHECK (
    "leaseUntil" <= "heartbeatAt" + CASE "capability"
        WHEN 'outbound' THEN interval '1 minute'
        WHEN 'inbound' THEN interval '2 minutes'
        ELSE interval '5 minutes'
    END
    AND ("state" <> 'held' OR "leaseUntil" > "heartbeatAt")
    AND ("state" <> 'released' OR "lastReleasedAt" IS NOT NULL)
);

-- At most one open binding per transport. Closed bindings remain as history.
CREATE UNIQUE INDEX "WhatsAppTransportBinding_open_transport_key"
ON "WhatsAppTransportBinding" ("transportKind", "transportRef")
WHERE "closedAt" IS NULL;

-- Every function in this migration keeps the search_path of the session that
-- created it (SET search_path FROM CURRENT), so a caller cannot redirect the
-- names the guards use. That path can name more than one schema: prisma migrate
-- deploy without a schema parameter runs under "$user", public, and "$user" is
-- expanded each time a guard runs. Each guard therefore first refuses unless the
-- effective path is exactly the schema of the table that fired it, checked with
-- schema-qualified built-ins only. Relations and types are still looked up in the
-- session temp schema first, so guards also prove that the foundation table names
-- resolve to the tables in that schema, read them with FROM ONLY so a temp child
-- table cannot add rows, and name types only through SQL keywords, which always
-- mean the built-in types. Objects in the foundation schema itself are trusted
-- like the table owner: a role that can create them can already disable or
-- replace the guards.
CREATE FUNCTION "whatsapp_account_foundation_resolves"(foundation_schema TEXT)
RETURNS BOOLEAN AS $$
BEGIN
    RETURN to_regclass('"WhatsAppAccount"') IS NOT DISTINCT FROM to_regclass(format('%I.%I', foundation_schema, 'WhatsAppAccount'))
        AND to_regclass('"WhatsAppAccountKey"') IS NOT DISTINCT FROM to_regclass(format('%I.%I', foundation_schema, 'WhatsAppAccountKey'))
        AND to_regclass('"WhatsAppTransportBinding"') IS NOT DISTINCT FROM to_regclass(format('%I.%I', foundation_schema, 'WhatsAppTransportBinding'))
        AND to_regclass('"WhatsAppCapabilityLease"') IS NOT DISTINCT FROM to_regclass(format('%I.%I', foundation_schema, 'WhatsAppCapabilityLease'));
END;
$$ LANGUAGE plpgsql STABLE SET search_path FROM CURRENT;

-- Durable history: statement-level truncation is refused on every new table.
CREATE FUNCTION "whatsapp_account_foundation_truncate_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is durable WhatsApp account history and cannot be truncated', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "WhatsAppAccount_truncate_guard"
BEFORE TRUNCATE ON "WhatsAppAccount"
FOR EACH STATEMENT EXECUTE FUNCTION "whatsapp_account_foundation_truncate_guard"();

CREATE TRIGGER "WhatsAppAccountKey_truncate_guard"
BEFORE TRUNCATE ON "WhatsAppAccountKey"
FOR EACH STATEMENT EXECUTE FUNCTION "whatsapp_account_foundation_truncate_guard"();

CREATE TRIGGER "WhatsAppTransportBinding_truncate_guard"
BEFORE TRUNCATE ON "WhatsAppTransportBinding"
FOR EACH STATEMENT EXECUTE FUNCTION "whatsapp_account_foundation_truncate_guard"();

CREATE TRIGGER "WhatsAppCapabilityLease_truncate_guard"
BEFORE TRUNCATE ON "WhatsAppCapabilityLease"
FOR EACH STATEMENT EXECUTE FUNCTION "whatsapp_account_foundation_truncate_guard"();

-- Account: identity is immutable, lifecycle follows the approved transitions,
-- retired is terminal. Leaving active needs every capability lease released
-- first, and retirement needs every transport binding closed first.
CREATE FUNCTION "whatsapp_account_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'WhatsApp account foundation guards must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF NOT "whatsapp_account_foundation_resolves"(TG_TABLE_SCHEMA) THEN
        RAISE EXCEPTION 'WhatsApp account foundation tables must resolve to the schema of %', TG_TABLE_NAME;
    END IF;
    -- The cross-table rules rely on READ COMMITTED: each statement below reads the
    -- rows committed before it, after the account row lock. An older snapshot of
    -- REPEATABLE READ or SERIALIZABLE would not see the write that the lock waited for.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'WhatsApp account foundation writes require READ COMMITTED isolation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'WhatsAppAccount rows are permanent and cannot be removed';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW."lifecycle" <> 'pending_approval' OR NEW."lifecycleVersion" <> 1 THEN
            RAISE EXCEPTION 'WhatsAppAccount starts as pending_approval at lifecycle version 1';
        END IF;
        NEW."createdAt" := now();
        NEW."lifecycleChangedAt" := now();
        RETURN NEW;
    END IF;

    IF NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."accountKind" IS DISTINCT FROM OLD."accountKind"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'WhatsAppAccount identity is immutable';
    END IF;

    -- lifecycleChangedAt is stored at millisecond precision, so compare at that precision.
    IF now()::TIMESTAMP(3) WITH TIME ZONE < OLD."lifecycleChangedAt" THEN
        RAISE EXCEPTION 'WhatsAppAccount lifecycle cannot change from a transaction that started before its latest lifecycle change';
    END IF;

    IF NOT (
        (OLD."lifecycle" = 'pending_approval' AND NEW."lifecycle" IN ('active', 'rejected'))
        OR (OLD."lifecycle" = 'active' AND NEW."lifecycle" = 'disabled')
        OR (OLD."lifecycle" = 'disabled' AND NEW."lifecycle" IN ('active', 'retired'))
        OR (OLD."lifecycle" = 'rejected' AND NEW."lifecycle" = 'pending_approval')
    ) THEN
        RAISE EXCEPTION 'WhatsAppAccount lifecycle transition from % to % is not permitted',
            OLD."lifecycle", NEW."lifecycle";
    END IF;

    IF NEW."lifecycleVersion" <> OLD."lifecycleVersion" + 1 THEN
        RAISE EXCEPTION 'WhatsAppAccount lifecycle version must advance by exactly one per transition';
    END IF;
    NEW."lifecycleChangedAt" := now();

    IF NEW."lifecycle" = 'active' THEN
        PERFORM 1 FROM ONLY "WhatsAppAccountKey"
        WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_pn_user';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount activation requires the complete provider key set';
        END IF;
        PERFORM 1 FROM ONLY "WhatsAppAccountKey"
        WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_lid_user';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount activation requires the complete provider key set';
        END IF;
    END IF;

    IF OLD."lifecycle" = 'active' THEN
        PERFORM 1 FROM ONLY "WhatsAppCapabilityLease"
        WHERE "accountId" = NEW."accountId" AND "state" = 'held';
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount cannot leave active while a capability lease is held';
        END IF;
    END IF;

    IF NEW."lifecycle" = 'retired' THEN
        PERFORM 1 FROM ONLY "WhatsAppTransportBinding"
        WHERE "accountId" = NEW."accountId" AND "closedAt" IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount cannot retire while a transport binding is open';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "WhatsAppAccount_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppAccount"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_guard"();

-- A new account establishes an identity only with its complete key set, both
-- kinds recorded in the creating transaction. A partial set never creates an
-- account, and with one key per kind a later key can never be appended.
CREATE FUNCTION "whatsapp_account_key_set_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'WhatsApp account foundation guards must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF NOT "whatsapp_account_foundation_resolves"(TG_TABLE_SCHEMA) THEN
        RAISE EXCEPTION 'WhatsApp account foundation tables must resolve to the schema of %', TG_TABLE_NAME;
    END IF;
    PERFORM 1 FROM ONLY "WhatsAppAccountKey"
    WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_pn_user';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppAccount must be created with the complete provider key set';
    END IF;
    PERFORM 1 FROM ONLY "WhatsAppAccountKey"
    WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_lid_user';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppAccount must be created with the complete provider key set';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE CONSTRAINT TRIGGER "WhatsAppAccount_key_set_complete"
AFTER INSERT ON "WhatsAppAccount"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_key_set_guard"();

-- Keys: ownership is permanent. A key is never re-pointed, rewritten or removed,
-- so a retired or rejected account keeps its provider keys reserved.
CREATE FUNCTION "whatsapp_account_key_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'WhatsApp account foundation guards must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF NOT "whatsapp_account_foundation_resolves"(TG_TABLE_SCHEMA) THEN
        RAISE EXCEPTION 'WhatsApp account foundation tables must resolve to the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'WhatsAppAccountKey ownership is permanent and immutable';
    END IF;
    PERFORM 1 FROM ONLY "WhatsAppAccountKey"
    WHERE "accountId" = NEW."accountId"
        AND "keyKind" <> NEW."keyKind"
        AND "keyValue" = NEW."keyValue";
    IF FOUND THEN
        RAISE EXCEPTION 'WhatsAppAccountKey PN and LID of one account must be different provider values';
    END IF;
    NEW."firstAttestedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "WhatsAppAccountKey_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppAccountKey"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_key_guard"();

-- Binding: identity, transport, generation and account are immutable; history
-- only advances, with bindingSeq contiguous and transportGeneration strictly
-- increasing per transport; trust follows the approved transitions with no
-- resurrection; a binding becomes verified only by an insert or update that
-- records a fresh attestation, and while a binding is pending a key pair it
-- already holds can be carried into a new window or verified only while its
-- current attestation window is still live; attestation
-- freshness only moves forward; attested provider values change only with a
-- new attestation, and each attested or claimed provider value is recorded at
-- most once; a binding holding a capability lease cannot close or leave
-- verified.
CREATE FUNCTION "whatsapp_transport_binding_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'WhatsApp account foundation guards must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF NOT "whatsapp_account_foundation_resolves"(TG_TABLE_SCHEMA) THEN
        RAISE EXCEPTION 'WhatsApp account foundation tables must resolve to the schema of %', TG_TABLE_NAME;
    END IF;
    -- The cross-table rules rely on READ COMMITTED: each statement below reads the
    -- rows committed before it, after the account row lock. An older snapshot of
    -- REPEATABLE READ or SERIALIZABLE would not see the write that the lock waited for.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'WhatsApp account foundation writes require READ COMMITTED isolation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding rows are durable history and cannot be removed';
    END IF;

    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM ONLY "WhatsAppAccount" WHERE "accountId" = NEW."accountId" FOR NO KEY UPDATE;
        PERFORM 1 FROM ONLY "WhatsAppAccount"
        WHERE "accountId" = NEW."accountId" AND "lifecycle" <> 'retired';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot open for a missing or retired account';
        END IF;
        PERFORM 1 FROM ONLY "WhatsAppAccount"
        WHERE "accountId" = NEW."accountId" AND "createdAt" <= now()::TIMESTAMP(3) WITH TIME ZONE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot open from a transaction that started before its account was created';
        END IF;
        IF NEW."trustState" NOT IN ('pending', 'verified') THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding opens as pending or verified';
        END IF;
        IF NEW."trustState" = 'verified'
            AND NOT COALESCE(NEW."attestedUntil" > clock_timestamp(), false) THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding opens as verified only with a fresh attestation';
        END IF;
        IF NEW."bindingSeq" < 1 OR NEW."transportGeneration" < 1 THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding bindingSeq and transportGeneration must be at least 1';
        END IF;
        -- One statement, so one snapshot, decides the slot history: the new
        -- binding takes exactly the next bindingSeq and a transportGeneration
        -- above every existing one, no binding on the slot is still open, and
        -- its transaction clock is not older than the latest openedAt, closedAt
        -- or lastAttestedAt recorded on the slot. A successor committed after
        -- this snapshot also needs that bindingSeq and collides on the unique
        -- slot index; a predecessor can only be closed while it is open, which
        -- this snapshot would have refused.
        PERFORM 1
        FROM (
            SELECT COALESCE(max("bindingSeq"), 0) AS "lastSeq",
                COALESCE(max("transportGeneration"), 0) AS "lastGeneration",
                COALESCE(GREATEST(max("openedAt"), max("closedAt"), max("lastAttestedAt")),
                    '-infinity'::TIMESTAMP WITH TIME ZONE) AS "lastEvent",
                count(*) FILTER (WHERE "closedAt" IS NULL) AS "openBindings"
            FROM ONLY "WhatsAppTransportBinding"
            WHERE "transportKind" = NEW."transportKind"
                AND "transportRef" = NEW."transportRef"
        ) AS "slotHistory"
        WHERE NEW."bindingSeq" = "slotHistory"."lastSeq" + 1
            AND NEW."transportGeneration" > "slotHistory"."lastGeneration"
            AND now()::TIMESTAMP(3) WITH TIME ZONE >= "slotHistory"."lastEvent"
            AND "slotHistory"."openBindings" = 0;
        IF NOT FOUND THEN
            -- The refusal is already decided; these reads only choose its message.
            PERFORM 1 FROM ONLY "WhatsAppTransportBinding"
            WHERE "transportKind" = NEW."transportKind"
                AND "transportRef" = NEW."transportRef"
                AND ("bindingSeq" >= NEW."bindingSeq" OR "transportGeneration" >= NEW."transportGeneration");
            IF FOUND THEN
                RAISE EXCEPTION 'WhatsAppTransportBinding history must advance: bindingSeq and transportGeneration both strictly increase';
            END IF;
            PERFORM 1
            FROM (
                SELECT COALESCE(max("bindingSeq"), 0) AS "lastSeq"
                FROM ONLY "WhatsAppTransportBinding"
                WHERE "transportKind" = NEW."transportKind"
                    AND "transportRef" = NEW."transportRef"
            ) AS "slotSequence"
            WHERE NEW."bindingSeq" = "slotSequence"."lastSeq" + 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'WhatsAppTransportBinding bindingSeq must be contiguous per transport';
            END IF;
            PERFORM 1 FROM ONLY "WhatsAppTransportBinding"
            WHERE "transportKind" = NEW."transportKind"
                AND "transportRef" = NEW."transportRef"
                AND "closedAt" IS NULL;
            IF FOUND THEN
                RAISE EXCEPTION 'WhatsAppTransportBinding cannot open while another binding on the transport is open';
            END IF;
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot open: the latest slot history is newer than this transaction or changed while it was checked';
        END IF;
        NEW."openedAt" := now();
        NEW."closedAt" := NULL;
        IF NEW."attestedUntil" IS NULL THEN
            NEW."lastAttestedAt" := NULL;
        ELSE
            NEW."lastAttestedAt" := now();
        END IF;
        IF NEW."operatorConfirmedAt" IS NOT NULL THEN
            NEW."operatorConfirmedAt" := clock_timestamp();
        END IF;
        RETURN NEW;
    END IF;

    IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId"
        OR NEW."transportKind" IS DISTINCT FROM OLD."transportKind"
        OR NEW."transportRef" IS DISTINCT FROM OLD."transportRef"
        OR NEW."transportGeneration" IS DISTINCT FROM OLD."transportGeneration"
        OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."bindingSeq" IS DISTINCT FROM OLD."bindingSeq"
        OR NEW."attestationOrigin" IS DISTINCT FROM OLD."attestationOrigin"
        OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding identity, transport, generation and account are immutable';
    END IF;

    PERFORM 1 FROM ONLY "WhatsAppAccount" WHERE "accountId" = OLD."accountId" FOR NO KEY UPDATE;

    IF OLD."closedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding is closed and frozen';
    END IF;

    IF NOT (
        (OLD."trustState" = 'pending' AND NEW."trustState" IN ('pending', 'verified', 'mismatched', 'revoked', 'closed'))
        OR (OLD."trustState" = 'verified' AND NEW."trustState" IN ('verified', 'mismatched', 'revoked', 'closed'))
    ) THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding trust transition from % to % is not permitted',
            OLD."trustState", NEW."trustState";
    END IF;

    IF (OLD."attestedPnValue" IS NOT NULL AND NEW."attestedPnValue" IS DISTINCT FROM OLD."attestedPnValue")
        OR (OLD."attestedLidValue" IS NOT NULL AND NEW."attestedLidValue" IS DISTINCT FROM OLD."attestedLidValue") THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding attested provider key set is immutable once recorded';
    END IF;

    IF (OLD."claimedPnValue" IS NOT NULL AND NEW."claimedPnValue" IS DISTINCT FROM OLD."claimedPnValue")
        OR (OLD."claimedLidValue" IS NOT NULL AND NEW."claimedLidValue" IS DISTINCT FROM OLD."claimedLidValue") THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding claimed provider key set is immutable once recorded';
    END IF;
    -- A claim is observed evidence, so it is never recorded from a transaction
    -- that started before the binding opened.
    IF ((OLD."claimedPnValue" IS NULL AND NEW."claimedPnValue" IS NOT NULL)
            OR (OLD."claimedLidValue" IS NULL AND NEW."claimedLidValue" IS NOT NULL))
        AND now()::TIMESTAMP(3) WITH TIME ZONE < OLD."openedAt" THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding claim cannot be recorded from a transaction that started before the binding opened';
    END IF;

    IF OLD."operatorConfirmedAt" IS NOT NULL
        AND (NEW."operatorConfirmedAt" IS DISTINCT FROM OLD."operatorConfirmedAt"
            OR NEW."operatorConfirmedBy" IS DISTINCT FROM OLD."operatorConfirmedBy") THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding operator confirmation is immutable once recorded';
    END IF;
    -- The confirmation is stamped when this statement runs, after the row lock has
    -- waited for any claim write, so it is never earlier than the claim it confirms.
    IF OLD."operatorConfirmedAt" IS NULL AND NEW."operatorConfirmedAt" IS NOT NULL THEN
        NEW."operatorConfirmedAt" := clock_timestamp();
    END IF;

    IF NEW."attestedUntil" IS DISTINCT FROM OLD."attestedUntil" THEN
        IF NEW."attestedUntil" IS NULL
            OR (OLD."attestedUntil" IS NOT NULL AND NEW."attestedUntil" < OLD."attestedUntil") THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding attestedUntil only moves forward';
        END IF;
        -- lastAttestedAt is stored at millisecond precision, so compare at that precision.
        IF OLD."lastAttestedAt" IS NOT NULL AND now()::TIMESTAMP(3) WITH TIME ZONE < OLD."lastAttestedAt" THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding attestation is older than the recorded attestation';
        END IF;
        IF OLD."trustState" = 'pending'
            AND OLD."attestedPnValue" IS NOT NULL
            AND NOT COALESCE(OLD."attestedUntil" > clock_timestamp(), false) THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding pending key pair counts only while its current attestation window is live';
        END IF;
        NEW."lastAttestedAt" := now();
    ELSIF NEW."lastAttestedAt" IS DISTINCT FROM OLD."lastAttestedAt"
        OR NEW."attestingInstanceId" IS DISTINCT FROM OLD."attestingInstanceId"
        OR NEW."attestedPnValue" IS DISTINCT FROM OLD."attestedPnValue"
        OR NEW."attestedLidValue" IS DISTINCT FROM OLD."attestedLidValue" THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding attestation fields change only with a new attestation';
    END IF;

    IF OLD."trustState" = 'pending' AND NEW."trustState" = 'verified'
        AND (NEW."attestedUntil" IS NOT DISTINCT FROM OLD."attestedUntil"
            OR NOT COALESCE(NEW."attestedUntil" > clock_timestamp(), false)) THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding becomes verified only with a fresh attestation recorded by the same update';
    END IF;

    IF NEW."trustState" IN ('mismatched', 'revoked', 'closed') THEN
        NEW."closedAt" := now();
    END IF;

    IF NEW."trustState" <> 'verified' THEN
        PERFORM 1 FROM ONLY "WhatsAppCapabilityLease"
        WHERE "holderBindingId" = OLD."bindingId" AND "state" = 'held';
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot close or leave verified while it holds a capability lease';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "WhatsAppTransportBinding_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppTransportBinding"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_transport_binding_guard"();

-- Capability lease: one row per account and capability, never removed.
-- First acquisition inserts epoch 1 and version 1. Every write advances version
-- by one; epoch stays or advances by one. Within an epoch the holder is fixed
-- and a released epoch is never revived. A new epoch needs the previous one
-- released or expired and its quarantine over. A release whose transaction does
-- not declare the holder quarantines the old lease window for in-flight calls;
-- the holder declares itself by setting yoko.whatsapp_lease_holder to its
-- holderInstanceId, a colon and the current transaction id, so a value left
-- over from another transaction never counts. The declaration is cooperative:
-- it marks a release as made by the holder and does not authenticate the
-- caller. A renew never shortens the granted window, and no lease write comes
-- from a transaction that started before the latest heartbeat. Acquire, renew
-- and takeover need an active account and an open, verified, freshly attested
-- holder binding of the same account.
-- leaseUntil is clamped to the capability maximum and, for outbound, to the
-- holder binding attestation.
CREATE FUNCTION "whatsapp_capability_lease_guard"()
RETURNS trigger AS $$
DECLARE
    attested_until TIMESTAMP WITH TIME ZONE;
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'WhatsApp account foundation guards must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF NOT "whatsapp_account_foundation_resolves"(TG_TABLE_SCHEMA) THEN
        RAISE EXCEPTION 'WhatsApp account foundation tables must resolve to the schema of %', TG_TABLE_NAME;
    END IF;
    -- The cross-table rules rely on READ COMMITTED: each statement below reads the
    -- rows committed before it, after the account row lock. An older snapshot of
    -- REPEATABLE READ or SERIALIZABLE would not see the write that the lock waited for.
    IF current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'WhatsApp account foundation writes require READ COMMITTED isolation';
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease rows are durable fencing history and cannot be removed';
    END IF;

    IF TG_OP = 'UPDATE'
        AND (NEW."accountId" IS DISTINCT FROM OLD."accountId"
            OR NEW."capability" IS DISTINCT FROM OLD."capability") THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease scope is immutable';
    END IF;

    PERFORM 1 FROM ONLY "WhatsAppAccount" WHERE "accountId" = NEW."accountId" FOR NO KEY UPDATE;

    IF TG_OP = 'INSERT' THEN
        IF NEW."epoch" <> 1 OR NEW."version" <> 1 OR NEW."state" <> 'held' THEN
            RAISE EXCEPTION 'WhatsAppCapabilityLease is first acquired as held at epoch 1 and version 1';
        END IF;
        NEW."fenceUntil" := now();
        NEW."lastReleasedAt" := NULL;
    ELSE
        -- heartbeatAt is stored at millisecond precision, so compare at that precision.
        -- A takeover from before a release already falls inside the quarantine of that release.
        IF now()::TIMESTAMP(3) WITH TIME ZONE < OLD."heartbeatAt" THEN
            RAISE EXCEPTION 'WhatsAppCapabilityLease cannot change from a transaction that started before its latest heartbeat';
        END IF;
        IF NEW."version" <> OLD."version" + 1 THEN
            RAISE EXCEPTION 'WhatsAppCapabilityLease version must advance by exactly one';
        END IF;
        IF NEW."epoch" < OLD."epoch" OR NEW."epoch" > OLD."epoch" + 1 THEN
            RAISE EXCEPTION 'WhatsAppCapabilityLease epoch must be monotonic and contiguous';
        END IF;

        IF NEW."epoch" = OLD."epoch" THEN
            IF NEW."holderBindingId" IS DISTINCT FROM OLD."holderBindingId"
                OR NEW."holderInstanceId" IS DISTINCT FROM OLD."holderInstanceId" THEN
                RAISE EXCEPTION 'WhatsAppCapabilityLease holder cannot change without a new epoch';
            END IF;
            IF OLD."state" = 'released' THEN
                RAISE EXCEPTION 'WhatsAppCapabilityLease released epoch cannot be revived or rewritten';
            END IF;
            IF NEW."state" = 'released' THEN
                NEW."heartbeatAt" := OLD."heartbeatAt";
                NEW."leaseUntil" := LEAST(OLD."leaseUntil", now());
                NEW."lastReleasedAt" := now();
                -- The stored fence is truncated to the millisecond, so it is never later
                -- than the clock the takeover gate compares it with, and a takeover in the
                -- same transaction as the release is not refused by rounding.
                IF COALESCE(current_setting('yoko.whatsapp_lease_holder', true), '')
                    = OLD."holderInstanceId" || ':' || pg_current_xact_id()::VARCHAR THEN
                    NEW."fenceUntil" := date_trunc('milliseconds', now());
                ELSE
                    NEW."fenceUntil" := GREATEST(OLD."leaseUntil", date_trunc('milliseconds', now()));
                END IF;
                RETURN NEW;
            END IF;
            NEW."fenceUntil" := OLD."fenceUntil";
        ELSE
            IF NEW."state" <> 'held' THEN
                RAISE EXCEPTION 'WhatsAppCapabilityLease new epoch must be held';
            END IF;
            IF OLD."fenceUntil" > now() THEN
                RAISE EXCEPTION 'WhatsAppCapabilityLease takeover refused while the previous epoch is quarantined';
            END IF;
            IF OLD."state" = 'held' AND OLD."leaseUntil" > now() THEN
                RAISE EXCEPTION 'WhatsAppCapabilityLease takeover refused before the held lease expires';
            END IF;
            NEW."fenceUntil" := now();
        END IF;
        NEW."lastReleasedAt" := OLD."lastReleasedAt";
    END IF;

    PERFORM 1 FROM ONLY "WhatsAppAccount"
    WHERE "accountId" = NEW."accountId" AND "lifecycle" = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease requires an active account';
    END IF;

    PERFORM 1 FROM ONLY "WhatsAppTransportBinding"
    WHERE "bindingId" = NEW."holderBindingId"
        AND "accountId" = NEW."accountId"
        AND "closedAt" IS NULL
        AND "trustState" = 'verified'
        AND "attestedUntil" > clock_timestamp();
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease holder binding must be open, verified and freshly attested for the same account';
    END IF;

    NEW."heartbeatAt" := now();
    NEW."leaseUntil" := LEAST(
        NEW."leaseUntil",
        now() + CASE NEW."capability"
            WHEN 'outbound' THEN interval '1 minute'
            WHEN 'inbound' THEN interval '2 minutes'
            ELSE interval '5 minutes'
        END
    );
    IF NEW."capability" = 'outbound' THEN
        FOR attested_until IN
            SELECT "attestedUntil" FROM ONLY "WhatsAppTransportBinding"
            WHERE "bindingId" = NEW."holderBindingId"
        LOOP
            NEW."leaseUntil" := LEAST(NEW."leaseUntil", attested_until);
        END LOOP;
    END IF;
    -- A renew never withdraws a window it already granted. Ending a lease early is
    -- a release, which quarantines the old window unless the holder declares it.
    IF TG_OP = 'UPDATE' AND NEW."epoch" = OLD."epoch" THEN
        NEW."leaseUntil" := GREATEST(NEW."leaseUntil", OLD."leaseUntil");
    END IF;
    IF NEW."leaseUntil" <= now() THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease leaseUntil must be in the future';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "WhatsAppCapabilityLease_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppCapabilityLease"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_capability_lease_guard"();

COMMIT;
