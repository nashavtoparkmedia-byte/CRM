const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function inspect() {
  console.log('--- Inspecting messages for 11, 12, 13, 14, 15 ---');
  
  const botMessages = await prisma.botChatMessage.findMany({
    where: { text: { in: ['11', '12', '13', '14', '15'] } },
    orderBy: { createdAt: 'asc' }
  });
  
  console.log(`Found ${botMessages.length} messages in BotChatMessage:`);
  botMessages.forEach(m => console.log(`- ${m.text} (ID: ${m.id}, CreatedAt: ${m.createdAt.toISOString()})`));

  const unifiedMessages = await prisma.message.findMany({
    where: { content: { in: ['11', '12', '13', '14', '15'] } },
    orderBy: { createdAt: 'asc' }
  });
  
  console.log(`\nFound ${unifiedMessages.length} messages in Message (Unified):`);
  unifiedMessages.forEach(m => console.log(`- ${m.content} (ID: ${m.id}, SentAt: ${m.sentAt.toISOString()}, CreatedAt: ${m.createdAt.toISOString()})`));

  await prisma.$disconnect();
}

inspect().catch(console.error);
