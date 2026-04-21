-- 1. Add chatType column to Chat with default 'private'
ALTER TABLE "Chat" ADD COLUMN "chatType" TEXT NOT NULL DEFAULT 'private';

-- 2. Mark existing group chats (Telegram negative IDs)
UPDATE "Chat" SET "chatType" = 'group'
WHERE channel = 'telegram' AND "externalChatId" ~ '^telegram:-';

-- 3. Mark existing group chats (WhatsApp @g.us)
UPDATE "Chat" SET "chatType" = 'group'
WHERE channel = 'whatsapp' AND "externalChatId" LIKE '%@g.us';

-- 4. Add index on chatType
CREATE INDEX "Chat_chatType_idx" ON "Chat"("chatType");

-- 5. Create GroupVisibility table
CREATE TABLE "GroupVisibility" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "visibility" TEXT NOT NULL DEFAULT 'visible',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GroupVisibility_pkey" PRIMARY KEY ("id")
);

-- 6. Create unique index on userId + chatId
CREATE UNIQUE INDEX "GroupVisibility_userId_chatId_key" ON "GroupVisibility"("userId", "chatId");

-- 7. Create index on userId for filtering
CREATE INDEX "GroupVisibility_userId_idx" ON "GroupVisibility"("userId");

-- 8. Add foreign key to Chat
ALTER TABLE "GroupVisibility" ADD CONSTRAINT "GroupVisibility_chatId_fkey" FOREIGN KEY ("chatId") REFERENCES "Chat"("id") ON DELETE CASCADE ON UPDATE CASCADE;
