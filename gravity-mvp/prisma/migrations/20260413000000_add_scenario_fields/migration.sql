-- Add scenario fields to tasks table (Phase 1)
ALTER TABLE "tasks" ADD COLUMN "scenario" TEXT;
ALTER TABLE "tasks" ADD COLUMN "stage" TEXT;
ALTER TABLE "tasks" ADD COLUMN "stageEnteredAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "nextActionAt" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "slaDeadline" TIMESTAMP(3);
ALTER TABLE "tasks" ADD COLUMN "closedReason" TEXT;
ALTER TABLE "tasks" ADD COLUMN "closedComment" TEXT;

-- Indexes for scenario queries
CREATE INDEX "tasks_scenario_stage_isActive_idx" ON "tasks"("scenario", "stage", "isActive");
CREATE INDEX "tasks_driverId_scenario_isActive_idx" ON "tasks"("driverId", "scenario", "isActive");
CREATE INDEX "tasks_slaDeadline_idx" ON "tasks"("slaDeadline");
CREATE INDEX "tasks_nextActionAt_idx" ON "tasks"("nextActionAt");
