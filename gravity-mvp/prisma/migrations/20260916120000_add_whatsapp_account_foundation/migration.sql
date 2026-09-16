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
-- generation serving one account; re-pairing opens a new binding and never
-- redefines an old identity. Account lifecycle (operator intent) and binding
-- trust (attestation) are separate axes. Stale is derived from attestedUntil and
-- never stored. Pause, disable and history deletion are separate concepts; none
-- of them removes a row here.
--
-- Lock order for every writer: the WhatsAppAccount row, then
-- WhatsAppCapabilityLease rows by capability, then WhatsAppTransportBinding rows.
-- Every guard trigger on a lease or a binding locks the account row first, so a
-- cross-table rule cannot be beaten by concurrent READ COMMITTED transactions.
-- All times come from the database clock.

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
    "attestedKeyKind" VARCHAR(32),
    "attestedKeyValue" VARCHAR(128),
    "claimedKeyKind" VARCHAR(32),
    "claimedKeyValue" VARCHAR(128),
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
CREATE INDEX "WhatsAppCapabilityLease_holderBindingId_idx" ON "WhatsAppCapabilityLease"("holderBindingId");

-- AddForeignKey
ALTER TABLE "WhatsAppAccountKey" ADD CONSTRAINT "WhatsAppAccountKey_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "WhatsAppAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attestedKeyKind_attestedKeyValue__fkey" FOREIGN KEY ("attestedKeyKind", "attestedKeyValue", "accountId") REFERENCES "WhatsAppAccountKey"("keyKind", "keyValue", "accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

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

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_trust_check" CHECK (
    "trustState" IN ('pending', 'verified', 'mismatched', 'revoked', 'closed')
    AND ("closedAt" IS NULL) = ("trustState" IN ('pending', 'verified'))
    AND ("closedAt" IS NULL) = ("closeReason" IS NULL)
    AND (
        "closeReason" IS NULL
        OR "closeReason" IN (
            'account_changed', 'credential_invalid', 'logged_out', 'revoked_by_operator',
            'transport_retired', 'superseded', 'duplicate_transport_conflict'
        )
    )
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_key_check" CHECK (
    ("attestedKeyKind" IS NULL) = ("attestedKeyValue" IS NULL)
    AND ("claimedKeyKind" IS NULL) = ("claimedKeyValue" IS NULL)
    AND ("attestedKeyKind" IS NULL OR "attestedKeyKind" IN ('whatsapp_pn_user', 'whatsapp_lid_user'))
    AND ("claimedKeyKind" IS NULL OR "claimedKeyKind" IN ('whatsapp_pn_user', 'whatsapp_lid_user'))
    AND (
        "claimedKeyValue" IS NULL
        OR (
            char_length("claimedKeyValue") >= 1
            AND "claimedKeyValue" = btrim("claimedKeyValue")
            AND "claimedKeyValue" !~ '[[:cntrl:]]'
        )
    )
    AND ("attestationOrigin" <> 'transport_asserted' OR "claimedKeyKind" IS NOT NULL)
    AND (
        "attestationOrigin" <> 'transport_asserted'
        OR "attestedKeyKind" IS NULL
        OR ("attestedKeyKind" = "claimedKeyKind" AND "attestedKeyValue" = "claimedKeyValue")
    )
);

ALTER TABLE "WhatsAppTransportBinding" ADD CONSTRAINT "WhatsAppTransportBinding_attestation_check" CHECK (
    ("attestedUntil" IS NULL) = ("lastAttestedAt" IS NULL)
    AND (
        "attestedUntil" IS NULL
        OR ("attestedUntil" > "lastAttestedAt" AND "attestedUntil" <= "lastAttestedAt" + interval '1 hour')
    )
    AND ("trustState" <> 'verified' OR ("attestedKeyKind" IS NOT NULL AND "attestedUntil" IS NOT NULL))
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

-- Durable history: statement-level truncation is refused on every new table.
CREATE FUNCTION "whatsapp_account_foundation_truncate_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% is durable WhatsApp account history and cannot be truncated', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

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
        PERFORM 1 FROM "WhatsAppAccountKey"
        WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_pn_user';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount activation requires the complete provider key set';
        END IF;
        PERFORM 1 FROM "WhatsAppAccountKey"
        WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_lid_user';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount activation requires the complete provider key set';
        END IF;
    END IF;

    IF OLD."lifecycle" = 'active' THEN
        PERFORM 1 FROM "WhatsAppCapabilityLease"
        WHERE "accountId" = NEW."accountId" AND "state" = 'held';
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount cannot leave active while a capability lease is held';
        END IF;
    END IF;

    IF NEW."lifecycle" = 'retired' THEN
        PERFORM 1 FROM "WhatsAppTransportBinding"
        WHERE "accountId" = NEW."accountId" AND "closedAt" IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppAccount cannot retire while a transport binding is open';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WhatsAppAccount_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppAccount"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_guard"();

-- A new account establishes an identity only with its complete key set, both
-- kinds recorded in the creating transaction. A partial set never creates an
-- account, and with one key per kind a later key can never be appended.
CREATE FUNCTION "whatsapp_account_key_set_guard"()
RETURNS trigger AS $$
BEGIN
    PERFORM 1 FROM "WhatsAppAccountKey"
    WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_pn_user';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppAccount must be created with the complete provider key set';
    END IF;
    PERFORM 1 FROM "WhatsAppAccountKey"
    WHERE "accountId" = NEW."accountId" AND "keyKind" = 'whatsapp_lid_user';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppAccount must be created with the complete provider key set';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "WhatsAppAccount_key_set_complete"
AFTER INSERT ON "WhatsAppAccount"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_key_set_guard"();

-- Keys: ownership is permanent. A key is never re-pointed, rewritten or removed,
-- so a retired or rejected account keeps its provider keys reserved.
CREATE FUNCTION "whatsapp_account_key_guard"()
RETURNS trigger AS $$
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'WhatsAppAccountKey ownership is permanent and immutable';
    END IF;
    NEW."firstAttestedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WhatsAppAccountKey_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppAccountKey"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_account_key_guard"();

-- Binding: identity, transport, generation and account are immutable; history
-- only advances; trust follows the approved transitions with no resurrection;
-- a binding becomes verified only with a fresh attestation, and attestation
-- freshness only moves forward; a binding holding a capability lease cannot
-- close or leave verified.
CREATE FUNCTION "whatsapp_transport_binding_guard"()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding rows are durable history and cannot be removed';
    END IF;

    IF TG_OP = 'INSERT' THEN
        PERFORM 1 FROM "WhatsAppAccount" WHERE "accountId" = NEW."accountId" FOR NO KEY UPDATE;
        PERFORM 1 FROM "WhatsAppAccount"
        WHERE "accountId" = NEW."accountId" AND "lifecycle" <> 'retired';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot open for a missing or retired account';
        END IF;
        IF NEW."trustState" NOT IN ('pending', 'verified') THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding opens as pending or verified';
        END IF;
        PERFORM 1 FROM "WhatsAppTransportBinding"
        WHERE "transportKind" = NEW."transportKind"
            AND "transportRef" = NEW."transportRef"
            AND ("bindingSeq" >= NEW."bindingSeq" OR "transportGeneration" > NEW."transportGeneration");
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding history must advance: bindingSeq increases and transportGeneration never decreases';
        END IF;
        IF NEW."bindingSeq" > 1 THEN
            PERFORM 1 FROM "WhatsAppTransportBinding"
            WHERE "transportKind" = NEW."transportKind"
                AND "transportRef" = NEW."transportRef"
                AND "bindingSeq" = NEW."bindingSeq" - 1;
            IF NOT FOUND THEN
                RAISE EXCEPTION 'WhatsAppTransportBinding bindingSeq must be contiguous per transport';
            END IF;
        END IF;
        NEW."openedAt" := now();
        NEW."closedAt" := NULL;
        IF NEW."attestedUntil" IS NULL THEN
            NEW."lastAttestedAt" := NULL;
        ELSE
            NEW."lastAttestedAt" := now();
        END IF;
        IF NEW."operatorConfirmedAt" IS NOT NULL THEN
            NEW."operatorConfirmedAt" := now();
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
        OR NEW."claimedKeyKind" IS DISTINCT FROM OLD."claimedKeyKind"
        OR NEW."claimedKeyValue" IS DISTINCT FROM OLD."claimedKeyValue"
        OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding identity, transport, generation and account are immutable';
    END IF;

    PERFORM 1 FROM "WhatsAppAccount" WHERE "accountId" = OLD."accountId" FOR NO KEY UPDATE;

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

    IF OLD."attestedKeyKind" IS NOT NULL
        AND (NEW."attestedKeyKind" IS DISTINCT FROM OLD."attestedKeyKind"
            OR NEW."attestedKeyValue" IS DISTINCT FROM OLD."attestedKeyValue") THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding attested provider key is immutable once recorded';
    END IF;

    IF OLD."operatorConfirmedAt" IS NOT NULL
        AND (NEW."operatorConfirmedAt" IS DISTINCT FROM OLD."operatorConfirmedAt"
            OR NEW."operatorConfirmedBy" IS DISTINCT FROM OLD."operatorConfirmedBy") THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding operator confirmation is immutable once recorded';
    END IF;
    IF OLD."operatorConfirmedAt" IS NULL AND NEW."operatorConfirmedAt" IS NOT NULL THEN
        NEW."operatorConfirmedAt" := now();
    END IF;

    IF NEW."attestedUntil" IS DISTINCT FROM OLD."attestedUntil" THEN
        IF NEW."attestedUntil" IS NULL
            OR (OLD."attestedUntil" IS NOT NULL AND NEW."attestedUntil" < OLD."attestedUntil") THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding attestedUntil only moves forward';
        END IF;
        IF OLD."lastAttestedAt" IS NOT NULL AND now() < OLD."lastAttestedAt" THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding attestation is older than the recorded attestation';
        END IF;
        NEW."lastAttestedAt" := now();
    ELSIF NEW."lastAttestedAt" IS DISTINCT FROM OLD."lastAttestedAt"
        OR NEW."attestingInstanceId" IS DISTINCT FROM OLD."attestingInstanceId" THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding attestation fields change only with a new attestation';
    END IF;

    IF OLD."trustState" = 'pending' AND NEW."trustState" = 'verified'
        AND NOT COALESCE(NEW."attestedUntil" > clock_timestamp(), false) THEN
        RAISE EXCEPTION 'WhatsAppTransportBinding becomes verified only with a fresh attestation';
    END IF;

    IF NEW."trustState" IN ('mismatched', 'revoked', 'closed') THEN
        NEW."closedAt" := now();
    END IF;

    IF NEW."trustState" <> 'verified' THEN
        PERFORM 1 FROM "WhatsAppCapabilityLease"
        WHERE "holderBindingId" = OLD."bindingId" AND "state" = 'held';
        IF FOUND THEN
            RAISE EXCEPTION 'WhatsAppTransportBinding cannot close or leave verified while it holds a capability lease';
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WhatsAppTransportBinding_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppTransportBinding"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_transport_binding_guard"();

-- Capability lease: one row per account and capability, never removed.
-- First acquisition inserts epoch 1 and version 1. Every write advances version
-- by one; epoch stays or advances by one. Within an epoch the holder is fixed
-- and a released epoch is never revived. A new epoch needs the previous one
-- released or expired and its quarantine over. A release that does not come
-- from the holder quarantines the old lease window for in-flight calls; the
-- holder identifies itself with the transaction-local setting
-- yoko.whatsapp_lease_holder. Acquire, renew and takeover need an active account
-- and an open, verified, freshly attested holder binding of the same account.
-- leaseUntil is clamped to the capability maximum and, for outbound, to the
-- holder binding attestation.
CREATE FUNCTION "whatsapp_capability_lease_guard"()
RETURNS trigger AS $$
DECLARE
    attested_until TIMESTAMPTZ;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease rows are durable fencing history and cannot be removed';
    END IF;

    IF TG_OP = 'UPDATE'
        AND (NEW."accountId" IS DISTINCT FROM OLD."accountId"
            OR NEW."capability" IS DISTINCT FROM OLD."capability") THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease scope is immutable';
    END IF;

    PERFORM 1 FROM "WhatsAppAccount" WHERE "accountId" = NEW."accountId" FOR NO KEY UPDATE;

    IF TG_OP = 'INSERT' THEN
        IF NEW."epoch" <> 1 OR NEW."version" <> 1 OR NEW."state" <> 'held' THEN
            RAISE EXCEPTION 'WhatsAppCapabilityLease is first acquired as held at epoch 1 and version 1';
        END IF;
        NEW."fenceUntil" := now();
        NEW."lastReleasedAt" := NULL;
    ELSE
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
                IF COALESCE(current_setting('yoko.whatsapp_lease_holder', true), '') = OLD."holderInstanceId" THEN
                    NEW."fenceUntil" := now();
                ELSE
                    NEW."fenceUntil" := GREATEST(OLD."leaseUntil", now());
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

    PERFORM 1 FROM "WhatsAppAccount"
    WHERE "accountId" = NEW."accountId" AND "lifecycle" = 'active';
    IF NOT FOUND THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease requires an active account';
    END IF;

    PERFORM 1 FROM "WhatsAppTransportBinding"
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
            SELECT "attestedUntil" FROM "WhatsAppTransportBinding"
            WHERE "bindingId" = NEW."holderBindingId"
        LOOP
            NEW."leaseUntil" := LEAST(NEW."leaseUntil", attested_until);
        END LOOP;
    END IF;
    IF NEW."leaseUntil" <= now() THEN
        RAISE EXCEPTION 'WhatsAppCapabilityLease leaseUntil must be in the future';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "WhatsAppCapabilityLease_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "WhatsAppCapabilityLease"
FOR EACH ROW EXECUTE FUNCTION "whatsapp_capability_lease_guard"();

COMMIT;
