const { PrismaClient } = require('@prisma/client');

async function main() {
  console.log('--- STARTING EXTRACTION ---');
  const prisma = new PrismaClient();
  try {
    console.log('--- Telegram Connections ---');
    const tgConns = await prisma.telegramConnection.findMany();
    console.log(JSON.stringify(tgConns, null, 2));

    console.log('\n--- MAX Connections ---');
    const maxConns = await prisma.maxConnection.findMany();
    console.log(JSON.stringify(maxConns, null, 2));

    console.log('\n--- WhatsApp Connections ---');
    const waConns = await prisma.whatsAppConnection.findMany();
    console.log(JSON.stringify(waConns, null, 2));
  } catch (err) {
    console.error('ERROR during extraction:', err);
  } finally {
    await prisma.$disconnect();
    console.log('--- EXTRACTION COMPLETE ---');
  }
}

main();
