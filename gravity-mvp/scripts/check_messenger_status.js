/**
 * Messenger Health Check Script
 * Verifies that the expected messenger connections exist in the database and are active.
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkHealth() {
  console.log('🔍 Starting Messenger Health Check...\n');

  // 1. WhatsApp Connections
  const wa = await prisma.whatsAppConnection.findMany();
  process.stdout.write(`📱 WhatsApp: ${wa.length} connections found. `);
  const activeWa = wa.filter(c => c.status === 'ready' || c.status === 'authenticated');
  console.log(`(${activeWa.length} active/ready)`);
  wa.forEach(c => console.log(`   - ${c.phoneNumber}: ${c.status}`));

  // 2. Telegram Connections
  const tg = await prisma.telegramConnection.findMany();
  process.stdout.write(`✈️  Telegram: ${tg.length} connections found. `);
  const activeTg = tg.filter(c => c.isActive);
  console.log(`(${activeTg.length} active)`);
  tg.forEach(c => console.log(`   - ${c.phoneNumber || c.name}: ${c.isActive ? 'ACTIVE' : 'INACTIVE'}`));

  // 3. MAX Connections
  const max = await prisma.maxConnection.findMany();
  process.stdout.write(`🤖 MAX:      ${max.length} connections found. `);
  const activeMax = max.filter(c => c.isActive);
  console.log(`(${activeMax.length} active)`);
  max.forEach(c => console.log(`   - ${c.name}: ${c.isActive ? 'ACTIVE' : 'INACTIVE'}`));

  console.log('\n✅ Health check complete.');
}

checkHealth()
  .catch(err => {
    console.error('\n❌ Health check failed:', err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
