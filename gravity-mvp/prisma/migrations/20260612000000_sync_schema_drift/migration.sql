-- Синхронизация дрейфа: всё, что попало в БД через prisma db push без
-- миграций (после восстановленных 20260403/20260408050000/20260426000000/
-- 20260514230000). Сгенерировано prisma migrate diff
-- --from-migrations --to-schema-datamodel. Существующие БД (локальная, VPS)
-- уже в этом состоянии — там миграция помечается applied через resolve.
-- CreateEnum
CREATE TYPE "DriverActionKind" AS ENUM ('GET_PRICE', 'COMPLETE_ORDER', 'CANCEL_ORDER');

-- CreateEnum
CREATE TYPE "DriverActionStatus" AS ENUM ('PENDING', 'DONE', 'FAILED', 'TIMEOUT', 'NEEDS_REASON_PROBE', 'ESCALATED_TO_MANAGER');

-- CreateEnum
CREATE TYPE "ReachabilityStatus" AS ENUM ('confirmed', 'unreachable', 'unknown');

-- DropForeignKey
ALTER TABLE "tasks" DROP CONSTRAINT "tasks_driverId_fkey";

-- AlterTable
ALTER TABLE "AiAgentConfig" ADD COLUMN     "internEnabled" BOOLEAN NOT NULL DEFAULT true,
ALTER COLUMN "activeChannels" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "AiRetrievalPolicy" ALTER COLUMN "id" SET DEFAULT 'singleton';

-- AlterTable
ALTER TABLE "Call" ADD COLUMN     "clientSentiment" TEXT,
ADD COLUMN     "nextActionDue" TIMESTAMP(3),
ADD COLUMN     "nextActionType" TEXT,
ADD COLUMN     "outcome" TEXT;

-- AlterTable
ALTER TABLE "ContactIdentity" ADD COLUMN     "reachabilityCheckedAt" TIMESTAMP(3),
ADD COLUMN     "reachabilityStatus" "ReachabilityStatus" NOT NULL DEFAULT 'unknown';

-- AlterTable
ALTER TABLE "HistoryImportJob" ADD COLUMN     "connectionId" TEXT,
ALTER COLUMN "channels" DROP DEFAULT;

-- AlterTable
ALTER TABLE "KnowledgeBaseEntry" ALTER COLUMN "tags" DROP DEFAULT,
ALTER COLUMN "channels" DROP DEFAULT,
ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "Message" ADD COLUMN     "clientMessageId" TEXT;

-- AlterTable
ALTER TABLE "MessageEventLog" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "TelephonyAiConfig" ADD COLUMN     "criteria" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "nextActionOptions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "outcomeOptions" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "sentimentOptions" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "surveys" ALTER COLUMN "title" SET DEFAULT 'Новый опрос',
ALTER COLUMN "trigger_button" SET DEFAULT '📊 Опрос качества';

-- AlterTable
ALTER TABLE "tasks" ADD COLUMN     "scenarioData" JSONB DEFAULT '{}';

-- DropTable
DROP TABLE "usage_events";

-- CreateTable
CREATE TABLE "SyncStatus" (
    "service" TEXT NOT NULL,
    "lastRunAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL,
    "errorMessage" TEXT,
    "driversUpdated" INTEGER,
    "ordersProcessed" INTEGER,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncStatus_pkey" PRIMARY KEY ("service")
);

-- CreateTable
CREATE TABLE "WhatsAppChatRoster" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "oldestMsgKey" JSONB,
    "oldestMsgTs" TIMESTAMP(3),
    "newestMsgKey" JSONB,
    "newestMsgTs" TIMESTAMP(3),
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WhatsAppChatRoster_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DriverAction" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "kind" "DriverActionKind" NOT NULL,
    "orderId" TEXT,
    "shortOrderId" TEXT,
    "status" "DriverActionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedBy" TEXT NOT NULL,
    "scraperTaskId" TEXT,
    "result" JSONB,
    "errorMessage" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DriverAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiProposedReply" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "decisionMode" TEXT NOT NULL,
    "reasoning" TEXT,
    "sources" JSONB,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "takenAt" TIMESTAMP(3),
    "sentMessageId" TEXT,
    "dismissedAt" TIMESTAMP(3),
    "confirmedCorrectAt" TIMESTAMP(3),

    CONSTRAINT "AiProposedReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "WhatsAppChatRoster_connectionId_idx" ON "WhatsAppChatRoster"("connectionId");

-- CreateIndex
CREATE INDEX "WhatsAppChatRoster_connectionId_newestMsgTs_idx" ON "WhatsAppChatRoster"("connectionId", "newestMsgTs");

-- CreateIndex
CREATE UNIQUE INDEX "WhatsAppChatRoster_connectionId_jid_key" ON "WhatsAppChatRoster"("connectionId", "jid");

-- CreateIndex
CREATE INDEX "DriverAction_driverId_kind_status_idx" ON "DriverAction"("driverId", "kind", "status");

-- CreateIndex
CREATE INDEX "DriverAction_requestedAt_idx" ON "DriverAction"("requestedAt" DESC);

-- CreateIndex
CREATE INDEX "DriverAction_scraperTaskId_idx" ON "DriverAction"("scraperTaskId");

-- CreateIndex
CREATE UNIQUE INDEX "AiProposedReply_messageId_key" ON "AiProposedReply"("messageId");

-- CreateIndex
CREATE INDEX "AiProposedReply_chatId_generatedAt_idx" ON "AiProposedReply"("chatId", "generatedAt" DESC);

-- CreateIndex
CREATE INDEX "AiProposedReply_expiresAt_idx" ON "AiProposedReply"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_clientMessageId_key" ON "Message"("clientMessageId");

-- AddForeignKey
ALTER TABLE "DriverAction" ADD CONSTRAINT "DriverAction_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

