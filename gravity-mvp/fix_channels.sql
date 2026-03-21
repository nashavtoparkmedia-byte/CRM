UPDATE "Message" SET channel = 'whatsapp' WHERE channel IS NULL;
UPDATE "Message" SET channel = c.channel 
FROM "Chat" c 
WHERE "Message"."chatId" = c.id 
AND ("Message".channel IS NULL OR "Message".channel != c.channel);
