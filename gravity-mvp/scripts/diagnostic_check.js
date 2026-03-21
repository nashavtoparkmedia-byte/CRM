const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const missed = ['Хвост', 'Идея', 'Стол', 'Рыба', 'Мясо'];
  console.log('--- Checking BotChatMessage (History) ---');
  for (const text of missed) {
    const found = await prisma.botChatMessage.findFirst({
      where: { text: { contains: text } }
    });
    console.log(`${text}: ${found ? 'FOUND' : 'NOT FOUND'} (id: ${found?.id})`);
  }

  console.log('\n--- Checking Message (Unified) ---');
  for (const text of missed) {
    const found = await prisma.message.findFirst({
      where: { content: { contains: text } }
    });
    console.log(`${text}: ${found ? 'FOUND' : 'NOT FOUND'} (id: ${found?.id})`);
  }
}

check().catch(console.error).finally(() => prisma.$disconnect());
