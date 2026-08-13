-- Stable park identity for Yandex driver profiles.
-- Additive only: existing Driver rows are preserved and can be reconciled by
-- (externalParkId, externalDriverProfileId) without relying on phone, name, or lastExternalPark.

CREATE TABLE "Park" (
    "id" TEXT NOT NULL,
    "parkCode" TEXT NOT NULL,
    "parkName" TEXT NOT NULL,
    "externalParkId" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Park_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ParkConnection" (
    "id" TEXT NOT NULL,
    "parkId" TEXT NOT NULL,
    "apiConnectionId" TEXT NOT NULL,
    "externalParkId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "lastFailedSyncAt" TIMESTAMP(3),
    "lastErrorSummary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ParkConnection_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Driver" ADD COLUMN "externalDriverProfileId" TEXT;
ALTER TABLE "Driver" ADD COLUMN "externalParkId" TEXT;
ALTER TABLE "Driver" ADD COLUMN "parkId" TEXT;
ALTER TABLE "Driver" ADD COLUMN "sourceConnectionId" TEXT;

CREATE UNIQUE INDEX "Park_parkCode_key" ON "Park"("parkCode");
CREATE UNIQUE INDEX "Park_externalParkId_key" ON "Park"("externalParkId");
CREATE UNIQUE INDEX "ParkConnection_apiConnectionId_archivedAt_key" ON "ParkConnection"("apiConnectionId", "archivedAt");
CREATE INDEX "ParkConnection_parkId_enabled_idx" ON "ParkConnection"("parkId", "enabled");
CREATE INDEX "ParkConnection_externalParkId_idx" ON "ParkConnection"("externalParkId");
CREATE UNIQUE INDEX "Driver_externalParkId_externalDriverProfileId_key" ON "Driver"("externalParkId", "externalDriverProfileId");
CREATE INDEX "Driver_parkId_idx" ON "Driver"("parkId");
CREATE INDEX "Driver_sourceConnectionId_idx" ON "Driver"("sourceConnectionId");
CREATE INDEX "Driver_externalParkId_idx" ON "Driver"("externalParkId");

ALTER TABLE "ParkConnection" ADD CONSTRAINT "ParkConnection_parkId_fkey" FOREIGN KEY ("parkId") REFERENCES "Park"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ParkConnection" ADD CONSTRAINT "ParkConnection_apiConnectionId_fkey" FOREIGN KEY ("apiConnectionId") REFERENCES "ApiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_parkId_fkey" FOREIGN KEY ("parkId") REFERENCES "Park"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Driver" ADD CONSTRAINT "Driver_sourceConnectionId_fkey" FOREIGN KEY ("sourceConnectionId") REFERENCES "ApiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
