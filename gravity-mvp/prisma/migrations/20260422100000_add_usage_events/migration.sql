-- CreateTable
CREATE TABLE "usage_events" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "usage_events_action_createdAt_idx" ON "usage_events"("action", "createdAt");

-- CreateIndex
CREATE INDEX "usage_events_userId_createdAt_idx" ON "usage_events"("userId", "createdAt");
