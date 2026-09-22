-- Mobile Push v1: identity_access device registration.
-- Expand-only and additive: one new table and its indexes. No existing table,
-- column or row is touched, and nothing is backfilled.

-- Wrapped in one explicit transaction. The canonical replay proves a pending
-- migration rolls back cleanly, and it can only do that if the migration
-- declares its own transaction boundary rather than relying on the tool's.
BEGIN;

-- One stable row per Android app install, keyed by the device id inside the
-- verified mobile session. It is a delivery address bound to that session,
-- not an authorization subject. There is deliberately no foreign key:
-- Messaging refers to a registration only by id inside its own delivery
-- events, and revoking a registration must never touch Message state.
CREATE TABLE "MobileDeviceRegistration" (
    "id" TEXT NOT NULL,
    "deviceId" VARCHAR(128) NOT NULL,
    "fcmToken" VARCHAR(512),
    "credentialSubject" VARCHAR(128) NOT NULL,
    "runtimeOperatorId" VARCHAR(64) NOT NULL,
    "sessionBindingId" CHAR(64) NOT NULL,
    "sessionIssuedAt" TIMESTAMPTZ(3) NOT NULL,
    "sessionExpiresAt" TIMESTAMPTZ(3) NOT NULL,
    "sessionRevocationEpoch" VARCHAR(64) NOT NULL,
    "credentialKeyId" CHAR(16) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMPTZ(3) NOT NULL,
    "revokedAt" TIMESTAMPTZ(3),
    "revokedReason" VARCHAR(32),

    CONSTRAINT "MobileDeviceRegistration_pkey" PRIMARY KEY ("id")
);

-- One registration per device: a concurrent second registration for the same
-- device resolves to the same row instead of creating a second identity.
CREATE UNIQUE INDEX "MobileDeviceRegistration_deviceId_key" ON "MobileDeviceRegistration"("deviceId");

-- One device per live provider token. NULL (awaiting a new token, or revoked)
-- is distinct in PostgreSQL, so only live bindings are constrained.
CREATE UNIQUE INDEX "MobileDeviceRegistration_fcmToken_key" ON "MobileDeviceRegistration"("fcmToken");

-- The eligibility scan filters on revocation and session expiry.
CREATE INDEX "MobileDeviceRegistration_eligibility_idx" ON "MobileDeviceRegistration"("revokedAt", "sessionExpiresAt");

COMMIT;
