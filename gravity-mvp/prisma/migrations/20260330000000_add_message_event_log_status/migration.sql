-- Block 3: Add status field to MessageEventLog for pipeline queue management

ALTER TABLE "MessageEventLog" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE "MessageEventLog" ADD COLUMN "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE INDEX "MessageEventLog_status_idx" ON "MessageEventLog"("status");
CREATE INDEX "MessageEventLog_status_eventType_idx" ON "MessageEventLog"("status", "eventType");
