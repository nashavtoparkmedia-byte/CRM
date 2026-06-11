-- Восстановленная миграция (drift от prisma db push): колонки Chat.status
-- и Chat.requiresResponse существовали в БД до 20260408100000_conversation_workflow
-- (она делает UPDATE по status и requiresResponse), но создающей миграции
-- в истории не было.

ALTER TABLE "Chat" ADD COLUMN "requiresResponse" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Chat" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'new';

CREATE INDEX "Chat_status_idx" ON "Chat"("status");
