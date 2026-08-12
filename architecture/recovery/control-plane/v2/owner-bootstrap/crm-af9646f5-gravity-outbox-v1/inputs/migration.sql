-- CRM-ARCH-005 expand-only migration. No existing object is altered or removed.
CREATE TYPE "DomainOutboxStatus" AS ENUM (
  'pending',
  'processing',
  'retry_wait',
  'published',
  'dead_letter'
);

CREATE TABLE "domain_outbox_events" (
  "id" TEXT NOT NULL,
  "eventId" TEXT NOT NULL,
  "eventType" TEXT NOT NULL,
  "eventVersion" INTEGER NOT NULL,
  "aggregateType" TEXT NOT NULL,
  "aggregateId" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "status" "DomainOutboxStatus" NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 5,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "claimedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "lastError" VARCHAR(1000),
  "correlationId" TEXT,
  "causationId" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "domain_outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "domain_outbox_events_eventId_key"
  ON "domain_outbox_events"("eventId");

CREATE INDEX "domain_outbox_events_status_availableAt_createdAt_idx"
  ON "domain_outbox_events"("status", "availableAt", "createdAt");

CREATE INDEX "domain_outbox_events_aggregateType_aggregateId_createdAt_idx"
  ON "domain_outbox_events"("aggregateType", "aggregateId", "createdAt");
