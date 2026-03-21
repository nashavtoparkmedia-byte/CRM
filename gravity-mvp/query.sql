SELECT m.id, m."chatId", m.content, m.status, c.channel 
FROM "Message" m 
JOIN "Chat" c ON m."chatId" = c.id 
ORDER BY m."sentAt" DESC 
LIMIT 15;
