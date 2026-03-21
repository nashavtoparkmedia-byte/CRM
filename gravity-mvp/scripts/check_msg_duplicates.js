const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDuplicates() {
  console.log('--- Checking for Duplicate Messages ---');
  const messages = await prisma.message.findMany({
    where: {
      content: '11'
    },
    orderBy: { createdAt: 'desc' },
    take: 10
  });
  
  console.log(`Found ${messages.length} messages with content "11":`);
  messages.forEach(m => {
    console.log(`ID: ${m.id}, ExternalID: ${m.externalId}, CreatedAt: ${m.createdAt}, Side: ${m.direction}`);
  });
}

checkDuplicates()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
