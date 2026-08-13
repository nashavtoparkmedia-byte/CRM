-- Cross-park person resolution for DriverProfile attachment.
-- Additive only. Stores protected provider/person fingerprints, never raw sensitive identifiers.

ALTER TABLE "Driver" ADD COLUMN "externalPersonKey" TEXT;
ALTER TABLE "Driver" ADD COLUMN "personKeyType" TEXT;
ALTER TABLE "Driver" ADD COLUMN "personResolutionStatus" TEXT NOT NULL DEFAULT 'unlinked';
ALTER TABLE "Driver" ADD COLUMN "personResolutionBasis" TEXT;
ALTER TABLE "Driver" ADD COLUMN "personResolutionAt" TIMESTAMP(3);
ALTER TABLE "Driver" ADD COLUMN "personResolvedBy" TEXT;

CREATE INDEX "Driver_externalPersonKey_idx" ON "Driver"("externalPersonKey");
CREATE INDEX "Driver_personResolutionStatus_idx" ON "Driver"("personResolutionStatus");
