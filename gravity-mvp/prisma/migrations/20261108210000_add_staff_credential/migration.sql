-- Staff Session v1 (identity_access): individual password verifiers and their
-- revocation counters, plus an append-only audit. Expand-only: two new tables,
-- no change to any existing table. No name, role or status is stored here; the
-- employee registry stays the only authority for those (design v1.3, D1).

-- CreateTable
CREATE TABLE "StaffCredential" (
    "userId" VARCHAR(64) NOT NULL,
    "registryCreatedAt" VARCHAR(64) NOT NULL,
    "algo" VARCHAR(16) NOT NULL,
    "scryptN" INTEGER NOT NULL,
    "scryptR" INTEGER NOT NULL,
    "scryptP" INTEGER NOT NULL,
    "maxmemBytes" INTEGER NOT NULL,
    "salt" BYTEA NOT NULL,
    "hash" BYTEA NOT NULL,
    "sessionEpoch" INTEGER NOT NULL DEFAULT 0,
    "revokedAt" TIMESTAMPTZ(3),
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "updatedBy" VARCHAR(80) NOT NULL,

    CONSTRAINT "StaffCredential_pkey" PRIMARY KEY ("userId"),
    CONSTRAINT "StaffCredential_shape_check" CHECK (
        "algo" = 'scrypt'
        AND "scryptN" = 32768 AND "scryptR" = 8 AND "scryptP" = 1
        AND "maxmemBytes" = 67108864
        AND octet_length("salt") = 16 AND octet_length("hash") = 64
        AND "sessionEpoch" >= 0
        AND "registryCreatedAt" <> ''
    )
);

-- CreateTable
CREATE TABLE "StaffCredentialEvent" (
    "id" TEXT NOT NULL,
    "userId" VARCHAR(64) NOT NULL,
    "kind" VARCHAR(32) NOT NULL,
    "actor" VARCHAR(80) NOT NULL,
    "sid" CHAR(64),
    "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffCredentialEvent_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "StaffCredentialEvent_kind_check" CHECK (
        "kind" IN ('password_set', 'password_reset', 'epoch_bump', 'revoked', 'login', 'logout')
    )
);

-- CreateIndex
CREATE INDEX "StaffCredentialEvent_user_recorded_idx" ON "StaffCredentialEvent"("userId", "recordedAt");

-- The audit is append-only: no UPDATE, no DELETE.
CREATE FUNCTION "staff_credential_event_append_only"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'StaffCredentialEvent is append-only';
END;
$$;

CREATE TRIGGER "StaffCredentialEvent_append_only"
BEFORE UPDATE OR DELETE ON "StaffCredentialEvent"
FOR EACH ROW EXECUTE FUNCTION "staff_credential_event_append_only"();

-- A credential row is never deleted: disable and delete revoke it (revokedAt),
-- so a re-created id can never meet an empty slot (C-D2b).
CREATE FUNCTION "staff_credential_no_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'StaffCredential rows are revoked, never deleted';
END;
$$;

CREATE TRIGGER "StaffCredential_no_delete"
BEFORE DELETE ON "StaffCredential"
FOR EACH ROW EXECUTE FUNCTION "staff_credential_no_delete"();

