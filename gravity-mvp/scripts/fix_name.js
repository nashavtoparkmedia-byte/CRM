/* eslint-disable @typescript-eslint/no-require-imports */
const { restoreChatDisplayNameV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixName() {
  const externalChatId = 'telegram:316425068';
  console.log('Restoring name to "Ремезов Александр" for', externalChatId);
  
  await restoreChatDisplayNameV1(externalChatId, 'Ремезов Александр');
  
  console.log('Done.');
}

fixName().catch(console.error).finally(() => prisma.$disconnect());
