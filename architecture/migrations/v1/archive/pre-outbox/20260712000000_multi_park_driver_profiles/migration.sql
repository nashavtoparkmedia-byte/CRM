-- Multi-park driver profile support.
-- Existing Driver rows are preserved as the concrete Yandex profile rows.
-- Contact.yandexDriverId remains for backward compatibility; new relations allow
-- Contact -> many Driver profiles plus one optional main Driver profile.

ALTER TABLE "Driver" ADD COLUMN "contactId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mainDriverId" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mainDriverSelection" TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE "Contact" ADD COLUMN "mainDriverSelectedBy" TEXT;
ALTER TABLE "Contact" ADD COLUMN "mainDriverSelectedAt" TIMESTAMP(3);

UPDATE "Driver" d
SET "contactId" = c."id"
FROM "Contact" c
WHERE c."yandexDriverId" IS NOT NULL
  AND c."yandexDriverId" = d."yandexDriverId"
  AND d."contactId" IS NULL;

UPDATE "Contact" c
SET "mainDriverId" = d."id"
FROM "Driver" d
WHERE c."yandexDriverId" IS NOT NULL
  AND c."yandexDriverId" = d."yandexDriverId"
  AND c."mainDriverId" IS NULL;

CREATE UNIQUE INDEX "Contact_mainDriverId_key" ON "Contact"("mainDriverId");
CREATE INDEX "Driver_contactId_idx" ON "Driver"("contactId");

ALTER TABLE "Driver" ADD CONSTRAINT "Driver_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Contact" ADD CONSTRAINT "Contact_mainDriverId_fkey" FOREIGN KEY ("mainDriverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE "ContactDriverProfileAudit" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "driverId" TEXT,
    "previousMainDriverId" TEXT,
    "action" TEXT NOT NULL,
    "selectedBy" TEXT NOT NULL DEFAULT 'system',
    "reason" TEXT,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ContactDriverProfileAudit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ContactDriverProfileAudit_contactId_createdAt_idx" ON "ContactDriverProfileAudit"("contactId", "createdAt");
CREATE INDEX "ContactDriverProfileAudit_driverId_idx" ON "ContactDriverProfileAudit"("driverId");
ALTER TABLE "ContactDriverProfileAudit" ADD CONSTRAINT "ContactDriverProfileAudit_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE CASCADE ON UPDATE CASCADE;
