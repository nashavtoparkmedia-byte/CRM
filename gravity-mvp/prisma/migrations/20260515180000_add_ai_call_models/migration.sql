-- AI-initiated outbound calls: voice agent talks to a lead via FreeSWITCH
-- mod_audio_fork. Adds AiCallScenario (reusable script), AiCallMessage
-- (per-utterance transcript), plus Call.isAi flag and related fields tracking
-- the AI session state.

-- CreateEnum
CREATE TYPE "AiCallMessageRole" AS ENUM ('user', 'assistant', 'system', 'tool');

-- CreateEnum
CREATE TYPE "AiCallSessionStatus" AS ENUM ('starting', 'greeting', 'active', 'transferring', 'ended', 'failed');

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "isAi" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiScenarioId" TEXT,
ADD COLUMN     "aiSessionStatus" "AiCallSessionStatus",
ADD COLUMN     "aiTransferReason" TEXT;

-- CreateTable
CREATE TABLE "AiCallScenario" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "systemPrompt" TEXT NOT NULL,
    "questions" JSONB NOT NULL DEFAULT '[]',
    "targetDurationSec" INTEGER,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiCallScenario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiCallMessage" (
    "id" TEXT NOT NULL,
    "callId" TEXT NOT NULL,
    "role" "AiCallMessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION,
    "toolName" TEXT,
    "toolPayload" JSONB,
    "audioPath" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "durationMs" INTEGER,

    CONSTRAINT "AiCallMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Call_isAi_startedAt_idx" ON "Call"("isAi", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "AiCallMessage_callId_startedAt_idx" ON "AiCallMessage"("callId", "startedAt");

-- CreateIndex
CREATE INDEX "AiCallMessage_role_idx" ON "AiCallMessage"("role");

-- AddForeignKey
ALTER TABLE "Call" ADD CONSTRAINT "Call_aiScenarioId_fkey" FOREIGN KEY ("aiScenarioId") REFERENCES "AiCallScenario"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiCallMessage" ADD CONSTRAINT "AiCallMessage_callId_fkey" FOREIGN KEY ("callId") REFERENCES "Call"("id") ON DELETE CASCADE ON UPDATE CASCADE;
