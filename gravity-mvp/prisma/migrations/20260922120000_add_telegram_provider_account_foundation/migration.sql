-- CreateTable
CREATE TABLE "TelegramAccount" (
    "accountId" VARCHAR(64) NOT NULL,
    "accountKind" VARCHAR(32) NOT NULL,
    "providerUserId" VARCHAR(64) NOT NULL,
    "lifecycle" VARCHAR(32) NOT NULL,
    "lifecycleVersion" INTEGER NOT NULL,
    "lifecycleChangedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lifecycleChangedBy" VARCHAR(128) NOT NULL,
    "lifecycleReason" VARCHAR(256) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramAccount_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "TelegramTransportBinding" (
    "bindingId" VARCHAR(64) NOT NULL,
    "accountId" VARCHAR(64) NOT NULL,
    "transportKind" VARCHAR(32) NOT NULL,
    "transportRef" VARCHAR(128) NOT NULL,
    "transportGeneration" BIGINT NOT NULL,
    "trustState" VARCHAR(16) NOT NULL,
    "attestedProviderUserId" VARCHAR(64),
    "attestingInstanceId" VARCHAR(128) NOT NULL,
    "lastAttestedAt" TIMESTAMPTZ(3),
    "attestedUntil" TIMESTAMPTZ(3),
    "openTransportKey" VARCHAR(192),
    "openedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedAt" TIMESTAMPTZ(3),
    "closeReason" VARCHAR(32),

    CONSTRAINT "TelegramTransportBinding_pkey" PRIMARY KEY ("bindingId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_providerUserId_key" ON "TelegramAccount"("providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramAccount_accountId_providerUserId_key" ON "TelegramAccount"("accountId", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramTransportBinding_openTransportKey_key" ON "TelegramTransportBinding"("openTransportKey");

-- CreateIndex
CREATE INDEX "TelegramTransportBinding_accountId_idx" ON "TelegramTransportBinding"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramTransportBinding_transportKind_transportRef_transpo_key" ON "TelegramTransportBinding"("transportKind", "transportRef", "transportGeneration");

-- AddForeignKey
ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "TelegramAccount"("accountId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_accountId_attestedProviderUserId_fkey" FOREIGN KEY ("accountId", "attestedProviderUserId") REFERENCES "TelegramAccount"("accountId", "providerUserId") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- ---------------------------------------------------------------------------
-- M2A2-TG1 contract.
--
-- The provider identity is the exact numeric id returned by a live `getMe()`.
-- Nothing here may be inferred from a phone number, a display name, a session
-- row id or an environment string. A bot is a Telegram user, so bot and
-- personal ids share one id space and `providerUserId` is unique globally.
--
-- Lifecycle is administrative and changes only by explicit transition.
-- Readiness is derived from `attestedUntil` against the database clock and is
-- never stored.
-- ---------------------------------------------------------------------------

ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_identity_check" CHECK (
    char_length("accountId") >= 1
    AND "accountId" = btrim("accountId")
    AND "accountId" !~ '[[:cntrl:]]'
    AND "accountKind" IN ('mtproto_user', 'bot_api')
    AND "providerUserId" ~ '^[0-9]{1,64}$'
);

ALTER TABLE "TelegramAccount" ADD CONSTRAINT "TelegramAccount_lifecycle_check" CHECK (
    "lifecycle" IN ('pending_approval', 'active', 'rejected', 'disabled', 'retired')
    AND "lifecycleVersion" >= 1
    AND char_length("lifecycleChangedBy") >= 1
    AND "lifecycleChangedBy" = btrim("lifecycleChangedBy")
    AND "lifecycleChangedBy" !~ '[[:cntrl:]]'
    AND char_length("lifecycleReason") >= 1
    AND "lifecycleReason" = btrim("lifecycleReason")
    AND "lifecycleReason" !~ '[[:cntrl:]]'
);

ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_shape_check" CHECK (
    char_length("bindingId") >= 1
    AND "bindingId" = btrim("bindingId")
    AND "bindingId" !~ '[[:cntrl:]]'
    AND "transportKind" IN ('mtproto_session', 'bot_runtime')
    AND char_length("transportRef") >= 1
    AND "transportRef" = btrim("transportRef")
    AND "transportRef" !~ '[[:cntrl:]]'
    AND "transportGeneration" >= 1
    AND char_length("attestingInstanceId") >= 1
    AND "attestingInstanceId" = btrim("attestingInstanceId")
    AND "attestingInstanceId" !~ '[[:cntrl:]]'
    AND ("attestedProviderUserId" IS NULL OR "attestedProviderUserId" ~ '^[0-9]{1,64}$')
);

-- A close is never recorded as older than the opening or the attestation it ends.
ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_trust_check" CHECK (
    "trustState" IN ('pending', 'verified', 'mismatched', 'revoked', 'closed')
    AND ("closedAt" IS NULL) = ("trustState" IN ('pending', 'verified'))
    AND ("closedAt" IS NULL) = ("closeReason" IS NULL)
    AND (
        "closedAt" IS NULL
        OR (
            "closedAt" >= "openedAt"
            AND ("lastAttestedAt" IS NULL OR "closedAt" >= "lastAttestedAt")
        )
    )
    AND (
        "closeReason" IS NULL
        OR "closeReason" IN (
            'principal_changed', 'credential_invalid', 'logged_out',
            'revoked_by_operator', 'transport_retired', 'superseded'
        )
    )
);

-- One open binding per transport, carried as a plain unique constraint:
-- the key is set while the binding is open and NULL once it closes.
ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_open_key_check" CHECK (
    ("closedAt" IS NULL) = ("openTransportKey" IS NOT NULL)
    AND (
        "openTransportKey" IS NULL
        OR "openTransportKey" = "transportKind" || ':' || "transportRef"
    )
);

-- An attestation always carries a window, and a verified binding always carries
-- the principal it proved. The window is bounded so freshness cannot be forged.
ALTER TABLE "TelegramTransportBinding" ADD CONSTRAINT "TelegramTransportBinding_attestation_check" CHECK (
    ("attestedUntil" IS NULL) = ("lastAttestedAt" IS NULL)
    AND (
        "attestedUntil" IS NULL
        OR ("attestedUntil" > "lastAttestedAt" AND "attestedUntil" <= "lastAttestedAt" + interval '1 hour')
    )
    AND ("lastAttestedAt" IS NULL OR "lastAttestedAt" >= "openedAt")
    AND (
        "trustState" <> 'verified'
        OR ("attestedProviderUserId" IS NOT NULL AND "attestedUntil" IS NOT NULL)
    )
);

CREATE FUNCTION "telegram_account_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'TelegramAccount guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TelegramAccount rows are permanent and cannot be removed';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."lifecycle" <> 'pending_approval' OR NEW."lifecycleVersion" <> 1 THEN
            RAISE EXCEPTION 'TelegramAccount starts as pending_approval at lifecycle version 1';
        END IF;
        NEW."createdAt" := now();
        NEW."lifecycleChangedAt" := now();
        RETURN NEW;
    END IF;
    IF NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."accountKind" IS DISTINCT FROM OLD."accountKind"
        OR NEW."providerUserId" IS DISTINCT FROM OLD."providerUserId"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'TelegramAccount identity is immutable';
    END IF;
    IF NOT (
        (OLD."lifecycle" = 'pending_approval' AND NEW."lifecycle" IN ('active', 'rejected'))
        OR (OLD."lifecycle" = 'active' AND NEW."lifecycle" = 'disabled')
        OR (OLD."lifecycle" = 'disabled' AND NEW."lifecycle" IN ('active', 'retired'))
        OR (OLD."lifecycle" = 'rejected' AND NEW."lifecycle" = 'pending_approval')
    ) THEN
        RAISE EXCEPTION 'TelegramAccount lifecycle transition from % to % is not permitted',
            OLD."lifecycle", NEW."lifecycle";
    END IF;
    IF NEW."lifecycleVersion" <> OLD."lifecycleVersion" + 1 THEN
        RAISE EXCEPTION 'TelegramAccount lifecycle version must advance by exactly one per transition';
    END IF;
    IF NEW."lifecycle" = 'retired' THEN
        PERFORM 1 FROM ONLY "TelegramTransportBinding"
        WHERE "accountId" = NEW."accountId" AND "closedAt" IS NULL;
        IF FOUND THEN
            RAISE EXCEPTION 'TelegramAccount cannot retire while a transport binding is open';
        END IF;
    END IF;
    NEW."lifecycleChangedAt" := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "TelegramAccount_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "TelegramAccount"
FOR EACH ROW EXECUTE FUNCTION "telegram_account_guard"();

CREATE FUNCTION "telegram_transport_binding_guard"()
RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_schemas(false) OPERATOR(pg_catalog.<>) ARRAY[TG_TABLE_SCHEMA] THEN
        RAISE EXCEPTION 'TelegramTransportBinding guard must run with a search_path of only the schema of %', TG_TABLE_NAME;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'TelegramTransportBinding rows are durable history and cannot be removed';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."trustState" NOT IN ('pending', 'verified') THEN
            RAISE EXCEPTION 'TelegramTransportBinding opens as pending or verified';
        END IF;
        IF NEW."trustState" = 'verified'
            AND NOT COALESCE(NEW."attestedUntil" > clock_timestamp(), false) THEN
            RAISE EXCEPTION 'TelegramTransportBinding opens as verified only with a fresh attestation';
        END IF;
        NEW."openedAt" := now();
        NEW."closedAt" := NULL;
        IF NEW."attestedUntil" IS NULL THEN
            NEW."lastAttestedAt" := NULL;
        ELSE
            NEW."lastAttestedAt" := now();
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."bindingId" IS DISTINCT FROM OLD."bindingId"
        OR NEW."accountId" IS DISTINCT FROM OLD."accountId"
        OR NEW."transportKind" IS DISTINCT FROM OLD."transportKind"
        OR NEW."transportRef" IS DISTINCT FROM OLD."transportRef"
        OR NEW."transportGeneration" IS DISTINCT FROM OLD."transportGeneration"
        OR NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
        RAISE EXCEPTION 'TelegramTransportBinding identity, transport and generation are immutable';
    END IF;
    IF OLD."closedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'TelegramTransportBinding is closed and frozen';
    END IF;
    IF OLD."attestedProviderUserId" IS NOT NULL
        AND NEW."attestedProviderUserId" IS DISTINCT FROM OLD."attestedProviderUserId" THEN
        RAISE EXCEPTION 'TelegramTransportBinding attested principal is immutable once recorded';
    END IF;
    IF NOT (
        (OLD."trustState" = 'pending' AND NEW."trustState" IN ('pending', 'verified', 'mismatched', 'revoked', 'closed'))
        OR (OLD."trustState" = 'verified' AND NEW."trustState" IN ('verified', 'mismatched', 'revoked', 'closed'))
    ) THEN
        RAISE EXCEPTION 'TelegramTransportBinding trust transition from % to % is not permitted',
            OLD."trustState", NEW."trustState";
    END IF;
    IF NEW."attestedUntil" IS DISTINCT FROM OLD."attestedUntil" THEN
        IF NEW."attestedUntil" IS NULL
            OR (OLD."attestedUntil" IS NOT NULL AND NEW."attestedUntil" <= OLD."attestedUntil") THEN
            RAISE EXCEPTION 'TelegramTransportBinding attestedUntil only moves forward';
        END IF;
        -- lastAttestedAt is stored at millisecond precision, so compare at that precision.
        IF OLD."lastAttestedAt" IS NOT NULL AND now()::TIMESTAMP(3) WITH TIME ZONE < OLD."lastAttestedAt" THEN
            RAISE EXCEPTION 'TelegramTransportBinding attestation is older than the recorded attestation';
        END IF;
        NEW."lastAttestedAt" := now();
    ELSIF NEW."lastAttestedAt" IS DISTINCT FROM OLD."lastAttestedAt"
        OR NEW."attestingInstanceId" IS DISTINCT FROM OLD."attestingInstanceId" THEN
        RAISE EXCEPTION 'TelegramTransportBinding attestation fields change only with a new attestation';
    END IF;
    IF OLD."trustState" = 'pending' AND NEW."trustState" = 'verified'
        AND (NEW."attestedUntil" IS NOT DISTINCT FROM OLD."attestedUntil"
            OR NOT COALESCE(NEW."attestedUntil" > clock_timestamp(), false)) THEN
        RAISE EXCEPTION 'TelegramTransportBinding becomes verified only with a fresh attestation recorded by the same update';
    END IF;
    IF NEW."trustState" IN ('mismatched', 'revoked', 'closed') THEN
        NEW."closedAt" := now();
        NEW."openTransportKey" := NULL;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "TelegramTransportBinding_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "TelegramTransportBinding"
FOR EACH ROW EXECUTE FUNCTION "telegram_transport_binding_guard"();

CREATE FUNCTION "telegram_provider_account_truncate_guard"()
RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'Telegram provider account tables cannot be truncated';
END;
$$ LANGUAGE plpgsql SET search_path FROM CURRENT;

CREATE TRIGGER "TelegramAccount_truncate_guard"
BEFORE TRUNCATE ON "TelegramAccount"
FOR EACH STATEMENT EXECUTE FUNCTION "telegram_provider_account_truncate_guard"();

CREATE TRIGGER "TelegramTransportBinding_truncate_guard"
BEFORE TRUNCATE ON "TelegramTransportBinding"
FOR EACH STATEMENT EXECUTE FUNCTION "telegram_provider_account_truncate_guard"();
