-- Conversation Workflow: add ownership and timing fields

ALTER TABLE "Chat" ADD COLUMN "assignedToUserId" TEXT;
ALTER TABLE "Chat" ADD COLUMN "lastInboundAt" TIMESTAMP(3);
ALTER TABLE "Chat" ADD COLUMN "lastOutboundAt" TIMESTAMP(3);

CREATE INDEX "Chat_assignedToUserId_idx" ON "Chat"("assignedToUserId");
CREATE INDEX "Chat_status_assignedToUserId_idx" ON "Chat"("status", "assignedToUserId");

-- Backfill: normalize 'active' → 'open'
UPDATE "Chat" SET status = 'open' WHERE status = 'active';

-- Backfill: lastInboundAt from most recent inbound message
UPDATE "Chat" SET "lastInboundAt" = sub.ts
FROM (SELECT "chatId", MAX("sentAt") as ts FROM "Message" WHERE direction = 'inbound' GROUP BY "chatId") sub
WHERE "Chat".id = sub."chatId";

-- Backfill: lastOutboundAt from most recent outbound message
UPDATE "Chat" SET "lastOutboundAt" = sub.ts
FROM (SELECT "chatId", MAX("sentAt") as ts FROM "Message" WHERE direction = 'outbound' GROUP BY "chatId") sub
WHERE "Chat".id = sub."chatId";

-- Backfill: requiresResponse = true where last message is inbound and no outbound reply after it
UPDATE "Chat" SET "requiresResponse" = true
WHERE id IN (
  SELECT c.id FROM "Chat" c
  WHERE EXISTS (
    SELECT 1 FROM "Message" m1
    WHERE m1."chatId" = c.id AND m1.direction = 'inbound'
    AND NOT EXISTS (
      SELECT 1 FROM "Message" m2
      WHERE m2."chatId" = c.id AND m2.direction = 'outbound' AND m2."sentAt" > m1."sentAt"
    )
  )
  AND c.status != 'resolved'
);
