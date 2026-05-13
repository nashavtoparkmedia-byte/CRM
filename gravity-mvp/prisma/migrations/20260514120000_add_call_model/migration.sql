-- New SIP-based call tracking: model Call + enums CallDirection, CallStatus.
-- Driven by FreeSWITCH events via ESL listener in instrumentation.ts.

-- CreateEnum
CREATE TYPE "CallDirection" AS ENUM ('inbound', 'outbound');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('ringing', 'active', 'completed', 'missed', 'no_answer', 'busy', 'failed', 'rejected');

-- CreateTable
CREATE TABLE "Call" (
    "id" TEXT NOT NULL,
    "direction" "CallDirection" NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'ringing',
    "fromNumber" TEXT NOT NULL,
    "toNumber" TEXT NOT NULL,
    "driverId" TEXT,
    "contactId" TEXT,
    "managerId" TEXT,
    "fsUuid" TEXT,
    "sipCallId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "durationSec" INTEGER,
    "hangupCause" TEXT,
    "recordingUrl" TEXT,
    "recordingPath" TEXT,
    "transcript" TEXT,
    "aiScore" INTEGER,
    "aiSummary" TEXT,
    "aiAnalysis" JSONB,
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Call_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Call_fsUuid_key" ON "Call"("fsUuid");

-- CreateIndex
CREATE INDEX "Call_direction_startedAt_idx" ON "Call"("direction", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Call_driverId_idx" ON "Call"("driverId");

-- CreateIndex
CREATE INDEX "Call_contactId_idx" ON "Call"("contactId");

-- CreateIndex
CREATE INDEX "Call_managerId_startedAt_idx" ON "Call"("managerId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "Call_fromNumber_idx" ON "Call"("fromNumber");

-- CreateIndex
CREATE INDEX "Call_toNumber_idx" ON "Call"("toNumber");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;
