-- Восстановленная миграция: таблицы tasks/task_events исторически были
-- созданы через `prisma db push` без коммита миграции, из-за чего replay
-- истории падал на 20260404000000_add_contact_model (ALTER TABLE "tasks").
-- Состояние здесь — модель Task на момент до add_contact_model: без
-- contactId (20260404), без scenario-полей (20260413), driverId NOT NULL
-- (DROP NOT NULL пришёл в 20260426010000). Остальной дрейф (scenarioData
-- и пр.) досоздаётся хвостовой миграцией.

-- CreateEnum
CREATE TYPE "TaskSource" AS ENUM ('auto', 'manual', 'chat');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('todo', 'in_progress', 'waiting_reply', 'overdue', 'snoozed', 'done', 'cancelled', 'archived');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('critical', 'high', 'medium', 'low');

-- CreateTable
CREATE TABLE "tasks" (
    "id" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "source" "TaskSource" NOT NULL DEFAULT 'manual',
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'todo',
    "priority" "TaskPriority" NOT NULL DEFAULT 'medium',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "triggerType" TEXT,
    "triggerKey" TEXT,
    "dedupeKey" TEXT,
    "dueAt" TIMESTAMP(3),
    "assigneeId" TEXT,
    "createdBy" TEXT,
    "resolvedBy" TEXT,
    "chatId" TEXT,
    "originMessageId" TEXT,
    "originExcerpt" TEXT,
    "originCreatedAt" TIMESTAMP(3),
    "hasNewReply" BOOLEAN NOT NULL DEFAULT false,
    "lastInboundMessageAt" TIMESTAMP(3),
    "lastOutboundMessageAt" TIMESTAMP(3),
    "metadata" JSONB DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_events" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB DEFAULT '{}',
    "actorType" TEXT DEFAULT 'system',
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tasks_driverId_idx" ON "tasks"("driverId");

-- CreateIndex
CREATE INDEX "tasks_status_priority_dueAt_idx" ON "tasks"("status", "priority", "dueAt");

-- CreateIndex
CREATE INDEX "tasks_isActive_source_idx" ON "tasks"("isActive", "source");

-- CreateIndex
CREATE INDEX "tasks_chatId_idx" ON "tasks"("chatId");

-- CreateIndex
CREATE INDEX "tasks_assigneeId_idx" ON "tasks"("assigneeId");

-- CreateIndex
CREATE INDEX "task_events_taskId_createdAt_idx" ON "task_events"("taskId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "task_events_eventType_idx" ON "task_events"("eventType");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_events" ADD CONSTRAINT "task_events_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "tasks"("id") ON DELETE CASCADE ON UPDATE CASCADE;
