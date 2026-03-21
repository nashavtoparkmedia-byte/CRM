const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixName() {
  const externalChatId = 'telegram:316425068';
  console.log('Restoring name to "Ремезов Александр" for', externalChatId);
  
  await prisma.chat.update({
    where: { externalChatId },
    data: { name: 'Ремезов Александр' }
  });
  
  console.log('Done.');
}

fixName().catch(console.error).finally(() => prisma.$disconnect());
