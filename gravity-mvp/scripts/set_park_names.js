const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function run() {
  const all = await prisma.apiConnection.findMany({ select: { id: true, parkId: true, name: true } });
  console.log('Current parks:', JSON.stringify(all, null, 2));

  const yoko = await prisma.apiConnection.updateMany({
    where: { parkId: '3a23295d8d714c03b61a17a6fc86601b' },
    data: { name: 'Yoko' },
  });
  console.log('Updated Yoko:', yoko.count);

  const na = await prisma.apiConnection.updateMany({
    where: { parkId: '45e30e9d6b824c608e5d28719cb19a6e' },
    data: { name: 'Наш Автопарк' },
  });
  console.log('Updated НА:', na.count);

  const after = await prisma.apiConnection.findMany({ select: { id: true, parkId: true, name: true } });
  console.log('After update:', JSON.stringify(after, null, 2));

  await prisma.$disconnect();
}

run().catch(console.error);
