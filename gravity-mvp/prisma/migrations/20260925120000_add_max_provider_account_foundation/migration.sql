-- MAX Channel-owned provider account foundation (M2A2-MAX1A).
--
-- Expand-only SOURCE migration. This artifact is intentionally NOT applied by
-- this delivery goal; production deployment remains a separate reviewed
-- operation. It adds two new tables with their constraints and guard triggers
-- and touches no existing table: no existing row is changed or removed, no
-- historical MAX table is referenced, and no credential, session value or bot
-- token is stored.

BEGIN;

-- CreateTable
CREATE TABLE "MaxAccount" (
    "accountId" VARCHAR(64) NOT NULL,
    "providerUserId" VARCHAR(64) NOT NULL,
    "lifecycle" VARCHAR(32) NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "lifecycleChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycleChangedBy" VARCHAR(128) NOT NULL,
    "lifecycleChangeReason" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MaxAccount_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "MaxTransportBinding" (
    "bindingId" VARCHAR(64) NOT NULL,
    "accountId" VARCHAR(64) NOT NULL,
    "transportKind" VARCHAR(32) NOT NULL,
    "transportRef" VARCHAR(64) NOT NULL,
    "transportGeneration" BIGINT NOT NULL,
    "attestedProviderUserId" VARCHAR(64) NOT NULL,
    "attestingInstanceId" VARCHAR(128) NOT NULL,
    "lastAttestedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAuthEventKind" VARCHAR(32) NOT NULL,
    "openTransportKey" VARCHAR(128),
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" VARCHAR(32),

    CONSTRAINT "MaxTransportBinding_pkey" PRIMARY KEY ("bindingId")
);

-- CreateIndex
CREATE UNIQUE INDEX "MaxAccount_providerUserId_key" ON "MaxAccount"("providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxAccount_accountId_providerUserId_key" ON "MaxAccount"("accountId", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxTransportBinding_openTransportKey_key" ON "MaxTransportBinding"("openTransportKey");

-- CreateIndex
CREATE INDEX "MaxTransportBinding_accountId_idx" ON "MaxTransportBinding"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "MaxTransportBinding_transportKind_transportRef_transportGen_key" ON "MaxTransportBinding"("transportKind", "transportRef", "transportGeneration");

-- AddForeignKey
ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "MaxAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_accountId_attestedProviderUserId_fkey" FOREIGN KEY ("accountId", "attestedProviderUserId") REFERENCES "MaxAccount"("accountId", "providerUserId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- M2A2-MAX1A contract.
--
-- The provider identity is the principal the MAX runtime was authenticated as
-- on its live WebSocket. Nothing here may be inferred from a phone number, a
-- display name, a `MaxConnection` row id, an environment string or a historical
-- `MaxRouteIdentityBinding` value. The id is opaque: it is stored exactly as the
-- provider sent it and is never parsed as a number.
--
-- `transportRef` is the YOKO locator of the configured transport. Its shape
-- makes a collision with a provider id impossible, and it carries no foreign key
-- so no historical MAX table can become an identity source.
--
-- MAX publishes no notion of an authentication that expires, so there is no
-- attestation window and no stored or derived freshness state. A binding row
-- exists only because a live auth frame proved the principal it carries, so
-- there is no trust column and no durable mismatched state: a changed principal
-- closes the generation instead.
--
-- Lifecycle is administrative and changes only by explicit transition. This
-- migration performs no admission.
-- ---------------------------------------------------------------------------

ALTER TABLE "MaxAccount" ADD CONSTRAINT "MaxAccount_identity_check" CHECK (
    char_length("accountId") >= 1
    AND "accountId" = btrim("accountId")
    AND "accountId" !~ '[[:cntrl:]]'
    AND "providerUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
    AND "providerUserId" NOT IN ('legacy', 'max-default')
);

ALTER TABLE "MaxAccount" ADD CONSTRAINT "MaxAccount_lifecycle_check" CHECK (
    "lifecycle" IN ('pending_approval', 'active', 'rejected', 'disabled', 'retired')
    AND "lifecycleVersion" >= 1
    AND char_length("lifecycleChangedBy") >= 1
    AND "lifecycleChangedBy" = btrim("lifecycleChangedBy")
    AND "lifecycleChangedBy" !~ '[[:cntrl:]]'
    AND char_length("lifecycleChangeReason") >= 1
    AND "lifecycleChangeReason" = btrim("lifecycleChangeReason")
    AND "lifecycleChangeReason" !~ '[[:cntrl:]]'
);

ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_shape_check" CHECK (
    char_length("bindingId") >= 1
    AND "bindingId" = btrim("bindingId")
    AND "bindingId" !~ '[[:cntrl:]]'
    AND "transportKind" IN ('web_session')
    AND "transportRef" ~ '^max-personal-[0-9a-f]{24}$'
    AND "transportGeneration" >= 1
    AND char_length("attestingInstanceId") >= 1
    AND "attestingInstanceId" = btrim("attestingInstanceId")
    AND "attestingInstanceId" !~ '[[:cntrl:]]'
    AND "lastAuthEventKind" IN ('ws_auth_op19', 'ws_owner_op53')
    AND "attestedProviderUserId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$'
);

-- A close is never recorded as older than the opening or the attestation it ends,
-- and the only reason a generation closes today is a changed principal.
ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_close_check" CHECK (
    ("closedAt" IS NULL) = ("closeReason" IS NULL)
    AND (
        "closedAt" IS NULL
        OR ("closedAt" >= "openedAt" AND "closedAt" >= "lastAttestedAt")
    )
    AND ("closeReason" IS NULL OR "closeReason" IN ('principal_changed'))
);

-- One open binding per transport, carried as a plain unique constraint: the key
-- is set while the binding is open and NULL once it closes.
ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_open_key_check" CHECK (
    ("closedAt" IS NULL) = ("openTransportKey" IS NOT NULL)
    AND (
        "openTransportKey" IS NULL
        OR "openTransportKey" = "transportKind" || ':' || "transportRef"
    )
);

-- Evidence never precedes the generation it belongs to.
ALTER TABLE "MaxTransportBinding" ADD CONSTRAINT "MaxTransportBinding_attestation_check" CHECK (
    "lastAttestedAt" >= "openedAt"
);

CREATE FUNCTION "max_account_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'MaxAccount guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'MaxAccount rows are permanent and cannot be removed';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."lifecycle" <> 'pending_approval' OR NEW."lifecycleVersion" <> 1 THEN
            RAISE EXCEPTION 'MaxAccount starts as pending_approval at lifecycle version 1';
        END IF;
        NEW."createdAt" := now();
        NEW."lifecycleChangedAt" := now();
        RETURN NEW;
    END IF;
    IF NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."providerUserId" IS DISTINCT FROM OLD."providerUserId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'MaxAccount identity is immutable';
    END IF;
    IF NOT (
        (OLD."lifecycle" = 'pending_approval' AND NEW."lifecycle" IN ('active', 'rejected'))
        OR (OLD."lifecycle" = 'active' AND NEW."lifecycle" = 'disabled')
        OR (OLD."lifecycle" = 'disabled' AND NEW."lifecycle" IN ('active', 'retired'))
        OR (OLD."lifecycle" = 'rejected' AND NEW."lifecycle" = 'pending_approval')
    ) THEN
        RAISE EXCEPTION 'MaxAccount lifecycle transition from % to % is not permitted',
            OLD."lifecycle", NEW."lifecycle";
    END IF;
    IF NEW."lifecycleVersion" <> OLD."lifecycleVersion" + 1 THEN
        RAISE EXCEPTION 'MaxAccount lifecycle version must advance by exactly one per transition';
    END IF;
    IF NEW."lifecycle" = 'retired' THEN
        PERFORM 1 FROM ONLY "MaxTransportBinding"
        WHERE "accountId" = NEW."accountId" AND "closedAt" IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'MaxAccount cannot retire while a transport binding is open';
        END IF;
    END IF;
    NEW."lifecycleChangedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "MaxAccount_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MaxAccount"
FOR EACH ROW EXECUTE FUNCTION "max_account_guard"();

CREATE FUNCTION "max_transport_binding_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'MaxTransportBinding guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'MaxTransportBinding rows are durable history and cannot be removed';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."closedAt" IS NOT NULL OR NEW."closeReason" IS NOT NULL THEN
            RAISE EXCEPTION 'MaxTransportBinding opens only as an open generation';
        END IF;
        NEW."openedAt" := now();
        NEW."lastAttestedAt" := now();
        RETURN NEW;
    END IF;
    IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId"
        OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."transportKind" IS DISTINCT FROM OLD."transportKind"
        OR NEW."transportRef" IS DISTINCT FROM OLD."transportRef"
        OR NEW."transportGeneration" IS DISTINCT FROM OLD."transportGeneration"
        OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'MaxTransportBinding identity, transport and generation are immutable';
    END IF;
    IF OLD."closedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'MaxTransportBinding is closed and frozen';
    END IF;
    IF NEW."attestedProviderUserId" IS DISTINCT FROM OLD."attestedProviderUserId" THEN
        RAISE EXCEPTION 'MaxTransportBinding attested principal is immutable once recorded';
    END IF;
    IF NEW."closeReason" IS DISTINCT FROM OLD."closeReason" THEN
        -- The writer closes a generation by naming the reason; the guard owns the
        -- closing bookkeeping so a close can never leave an open key behind.
        IF NEW."closeReason" IS NULL THEN
            RAISE EXCEPTION 'MaxTransportBinding close reason cannot be withdrawn';
        END IF;
        NEW."closedAt" := now();
        NEW."openTransportKey" := NULL;
        RETURN NEW;
    END IF;
    IF NEW."closedAt" IS DISTINCT FROM OLD."closedAt"
        OR NEW."openTransportKey" IS DISTINCT FROM OLD."openTransportKey" THEN
        RAISE EXCEPTION 'MaxTransportBinding closes only by recording a close reason';
    END IF;
    -- Any other permitted update is a re-observation of the same principal, so
    -- the evidence timestamp advances with it and never moves backwards.
    IF NEW."lastAttestedAt" IS DISTINCT FROM OLD."lastAttestedAt" THEN
        RAISE EXCEPTION 'MaxTransportBinding evidence timestamp is maintained by the guard';
    END IF;
    IF now()::TIMESTAMP(3) WITH TIME ZONE < OLD."lastAttestedAt" THEN
        RAISE EXCEPTION 'MaxTransportBinding observation is older than the recorded evidence';
    END IF;
    NEW."lastAttestedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "MaxTransportBinding_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "MaxTransportBinding"
FOR EACH ROW EXECUTE FUNCTION "max_transport_binding_guard"();

CREATE FUNCTION "max_provider_account_truncate_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'MAX provider account tables cannot be truncated';
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "MaxAccount_truncate_guard"
BEFORE TRUNCATE ON "MaxAccount"
FOR EACH STATEMENT EXECUTE FUNCTION "max_provider_account_truncate_guard"();

CREATE TRIGGER "MaxTransportBinding_truncate_guard"
BEFORE TRUNCATE ON "MaxTransportBinding"
FOR EACH STATEMENT EXECUTE FUNCTION "max_provider_account_truncate_guard"();

COMMIT;
