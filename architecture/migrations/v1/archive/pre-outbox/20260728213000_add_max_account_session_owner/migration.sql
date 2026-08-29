-- Next-release additive migration. It is intentionally not part of the exact
-- eight Stage 8B2A migration list and does not authorize production execution.
CREATE TABLE "MaxAccountSessionOwner" (
    "accountId" TEXT NOT NULL,
    "ownerInstanceId" TEXT NOT NULL,
    "fencingToken" BIGINT NOT NULL,
    "acquiredAt" TIMESTAMP(3) NOT NULL,
    "heartbeatAt" TIMESTAMP(3) NOT NULL,
    "leaseUntil" TIMESTAMP(3) NOT NULL,
    "lastReleasedAt" TIMESTAMP(3),
    "state" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MaxAccountSessionOwner_pkey" PRIMARY KEY ("accountId"),
    CONSTRAINT "MaxAccountSessionOwner_identity_check" CHECK (
        char_length("accountId") BETWEEN 1 AND 128
        AND "accountId" = btrim("accountId")
        AND "accountId" !~ '[[:cntrl:]]'
        AND "accountId" <> '*'
        AND char_length("ownerInstanceId") BETWEEN 1 AND 256
        AND "ownerInstanceId" = btrim("ownerInstanceId")
        AND "ownerInstanceId" !~ '[[:cntrl:]]'
        AND "ownerInstanceId" <> '*'
    ),
    CONSTRAINT "MaxAccountSessionOwner_fence_version_check" CHECK (
        "fencingToken" >= 1 AND "version" >= 1
    ),
    CONSTRAINT "MaxAccountSessionOwner_state_time_check" CHECK (
        "state" IN ('active', 'released')
        AND "heartbeatAt" >= "acquiredAt"
        AND (
            ("state" = 'active' AND "leaseUntil" > "heartbeatAt")
            OR ("state" = 'released' AND "lastReleasedAt" IS NOT NULL AND "leaseUntil" = "lastReleasedAt")
        )
    )
);

CREATE INDEX "MaxAccountSessionOwner_state_lease_idx"
ON "MaxAccountSessionOwner"("state", "leaseUntil");

CREATE FUNCTION "max_account_session_owner_fence_guard"()
RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner rows cannot be deleted because fencing tokens are durable';
    END IF;
    IF NEW."accountId" <> OLD."accountId" THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner accountId is immutable';
    END IF;
    IF NEW."version" <> OLD."version" + 1 THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner version must increment exactly once';
    END IF;
    IF NEW."fencingToken" < OLD."fencingToken" OR NEW."fencingToken" > OLD."fencingToken" + 1 THEN
        RAISE EXCEPTION 'MaxAccountSessionOwner fencing token must be monotonic and contiguous';
    END IF;
    IF NEW."fencingToken" = OLD."fencingToken" THEN
        IF NEW."ownerInstanceId" <> OLD."ownerInstanceId" OR NEW."acquiredAt" <> OLD."acquiredAt" THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner owner cannot change without a new fencing token';
        END IF;
        IF OLD."state" = 'released' AND NEW."state" = 'active' THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner released fencing token cannot be revived';
        END IF;
    ELSE
        IF NEW."state" <> 'active' OR NEW."acquiredAt" < OLD."acquiredAt" THEN
            RAISE EXCEPTION 'MaxAccountSessionOwner takeover must create a newer active fence';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "MaxAccountSessionOwner_fence_guard"
BEFORE UPDATE OR DELETE ON "MaxAccountSessionOwner"
FOR EACH ROW EXECUTE FUNCTION "max_account_session_owner_fence_guard"();

-- Rollback is a separately approved retention-aware operation. This migration
-- never deletes durable fencing history and performs no runtime enablement.
