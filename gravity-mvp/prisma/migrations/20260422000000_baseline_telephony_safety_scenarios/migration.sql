-- CreateEnum
CREATE TYPE "CallDisposition" AS ENUM ('answered', 'missed', 'busy', 'rejected', 'no_answer');

-- CreateEnum
CREATE TYPE "CallStatus" AS ENUM ('ringing', 'active', 'completed', 'failed');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('pending', 'delivered', 'executed', 'failed');

-- CreateEnum
CREATE TYPE "DeviceStatus" AS ENUM ('online', 'offline');

-- AlterEnum
ALTER TYPE "ChatChannel" ADD VALUE 'phone';

-- AlterEnum
ALTER TYPE "MessageType" ADD VALUE 'call';

-- AlterEnum
ALTER TYPE "ContactPhoneSource" ADD VALUE 'phone';

-- NOTE: ALTER TABLE "Chat" ADD COLUMN "chatType" — skipped, already in 20260410000000_add_chat_type_and_group_visibility

-- CreateTable
CREATE TABLE "CallSession" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "chatId" TEXT,
    "messageId" TEXT,
    "contactId" TEXT,
    "direction" "MessageDirection" NOT NULL,
    "callerNumber" TEXT NOT NULL,
    "calleeNumber" TEXT NOT NULL,
    "status" "CallStatus" NOT NULL DEFAULT 'ringing',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answeredAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "duration" INTEGER,
    "disposition" "CallDisposition",
    "androidCallId" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallSession_pkey" PRIMARY KEY ("id")
);

-- NOTE: CREATE TABLE "GroupVisibility" — skipped, already in 20260410000000_add_chat_type_and_group_visibility

-- CreateTable
CREATE TABLE "TelephonyCommand" (
    "id" TEXT NOT NULL,
    "deviceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'pending',
    "deliveredAt" TIMESTAMP(3),
    "executedAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "failReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelephonyCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelephonyDevice" (
    "id" TEXT NOT NULL,
    "androidId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phoneNumber" TEXT,
    "simOperator" TEXT,
    "status" "DeviceStatus" NOT NULL DEFAULT 'offline',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "revokedAt" TIMESTAMP(3),
    "lastHeartbeat" TIMESTAMP(3),
    "appVersion" TEXT,
    "deviceSecret" TEXT NOT NULL,
    "fcmToken" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelephonyDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "config_change_log" (
    "id" SERIAL NOT NULL,
    "parameter_name" TEXT NOT NULL,
    "previous_value" TEXT,
    "new_value" TEXT NOT NULL,
    "changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changed_by" TEXT,

    CONSTRAINT "config_change_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cron_health_log" (
    "id" SERIAL NOT NULL,
    "cron_name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ok',
    "executed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "metadata" JSONB,

    CONSTRAINT "cron_health_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "execution_lock" (
    "operation_name" TEXT NOT NULL,
    "locked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "locked_by" TEXT,

    CONSTRAINT "execution_lock_pkey" PRIMARY KEY ("operation_name")
);

-- CreateTable
CREATE TABLE "health_score_history" (
    "id" SERIAL NOT NULL,
    "manager_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "health_level" TEXT NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_score_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "health_snapshots" (
    "manager_id" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "decline_streak" INTEGER NOT NULL DEFAULT 0,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "health_snapshots_pkey" PRIMARY KEY ("manager_id")
);

-- CreateTable
CREATE TABLE "integrity_check_log" (
    "id" SERIAL NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration_ms" INTEGER NOT NULL DEFAULT 0,
    "total_issues" INTEGER NOT NULL DEFAULT 0,
    "critical_issues" INTEGER NOT NULL DEFAULT 0,
    "warning_issues" INTEGER NOT NULL DEFAULT 0,
    "details" JSONB,

    CONSTRAINT "integrity_check_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intervention_actions" (
    "id" TEXT NOT NULL,
    "manager_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "comment" TEXT,
    "score_at_action" INTEGER,
    "outcome" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intervention_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "perf_log" (
    "id" SERIAL NOT NULL,
    "operation_name" TEXT NOT NULL,
    "operation_type" TEXT NOT NULL DEFAULT 'other',
    "duration_ms" INTEGER NOT NULL,
    "is_slow" BOOLEAN NOT NULL DEFAULT false,
    "logged_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "perf_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scenario_field_settings" (
    "id" TEXT NOT NULL,
    "scenarioId" TEXT NOT NULL,
    "fieldId" TEXT NOT NULL,
    "showInList" BOOLEAN,
    "showInCard" BOOLEAN,
    "filterable" BOOLEAN,
    "sortable" BOOLEAN,
    "groupable" BOOLEAN,
    "order" INTEGER,
    "updatedAt" TIMESTAMP(6) DEFAULT CURRENT_TIMESTAMP,
    "updatedBy" TEXT,

    CONSTRAINT "scenario_field_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stability_check_log" (
    "id" SERIAL NOT NULL,
    "scope" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "anomaly_count" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,

    CONSTRAINT "stability_check_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CallSession_messageId_key" ON "CallSession"("messageId");

-- CreateIndex
CREATE INDEX "CallSession_calleeNumber_idx" ON "CallSession"("calleeNumber");

-- CreateIndex
CREATE INDEX "CallSession_callerNumber_idx" ON "CallSession"("callerNumber");

-- CreateIndex
CREATE INDEX "CallSession_chatId_idx" ON "CallSession"("chatId");

-- CreateIndex
CREATE INDEX "CallSession_contactId_idx" ON "CallSession"("contactId");

-- CreateIndex
CREATE INDEX "CallSession_deviceId_androidCallId_idx" ON "CallSession"("deviceId", "androidCallId");

-- CreateIndex
CREATE INDEX "CallSession_deviceId_startedAt_idx" ON "CallSession"("deviceId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "CallSession_deviceId_status_idx" ON "CallSession"("deviceId", "status");

-- NOTE: GroupVisibility_userId_idx and GroupVisibility_userId_chatId_key — skipped, already in 20260410000000_add_chat_type_and_group_visibility

-- CreateIndex
CREATE INDEX "TelephonyCommand_deviceId_status_idx" ON "TelephonyCommand"("deviceId", "status");

-- CreateIndex
CREATE INDEX "TelephonyCommand_status_createdAt_idx" ON "TelephonyCommand"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TelephonyDevice_androidId_key" ON "TelephonyDevice"("androidId");

-- CreateIndex
CREATE UNIQUE INDEX "TelephonyDevice_deviceSecret_key" ON "TelephonyDevice"("deviceSecret");

-- CreateIndex
CREATE INDEX "TelephonyDevice_isActive_idx" ON "TelephonyDevice"("isActive");

-- CreateIndex
CREATE INDEX "TelephonyDevice_lastHeartbeat_idx" ON "TelephonyDevice"("lastHeartbeat");

-- CreateIndex
CREATE INDEX "TelephonyDevice_status_idx" ON "TelephonyDevice"("status");

-- CreateIndex
CREATE INDEX "idx_config_change_log_time" ON "config_change_log"("changed_at" DESC);

-- CreateIndex
CREATE INDEX "idx_cron_health_log_name_time" ON "cron_health_log"("cron_name", "executed_at" DESC);

-- CreateIndex
CREATE INDEX "idx_hsh_manager_date" ON "health_score_history"("manager_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_hsh_manager_time" ON "health_score_history"("manager_id", "recorded_at" DESC);

-- CreateIndex
CREATE INDEX "idx_integrity_check_log_time" ON "integrity_check_log"("checked_at" DESC);

-- CreateIndex
CREATE INDEX "idx_intervention_actions_manager" ON "intervention_actions"("manager_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_perf_log_time" ON "perf_log"("logged_at" DESC);

-- CreateIndex
CREATE INDEX "scenario_field_settings_scenario_idx" ON "scenario_field_settings"("scenarioId");

-- CreateIndex
CREATE UNIQUE INDEX "scenario_field_settings_unique" ON "scenario_field_settings"("scenarioId", "fieldId");

-- CreateIndex
CREATE INDEX "idx_stability_check_log_time" ON "stability_check_log"("checked_at" DESC);

-- NOTE: Chat_chatType_idx — skipped, already in 20260410000000_add_chat_type_and_group_visibility

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "Contact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TelephonyDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallSession" ADD CONSTRAINT "CallSession_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- NOTE: GroupVisibility_chatId_fkey — skipped, already in 20260410000000_add_chat_type_and_group_visibility

-- AddForeignKey
ALTER TABLE "TelephonyCommand" ADD CONSTRAINT "TelephonyCommand_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "TelephonyDevice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

