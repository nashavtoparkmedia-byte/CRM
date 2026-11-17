/* eslint-disable @typescript-eslint/no-require-imports */
const { restoreChatDisplayNameV1 } = require('../src/modules/messaging/public/v1/legacy-prisma-chat-name-maintenance-adapter');
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function fixName() {
  const externalChatId = 'telegram:' + (process.env.YOKO_SCRIPT_TELEGRAM_ID || (() => { throw new Error('YOKO_SCRIPT_TELEGRAM_ID is required: no built-in Telegram id'); })());
  console.log('Restoring name to "Ремезов Александр" for', externalChatId);
  
  await restoreChatDisplayNameV1(externalChatId, 'Ремезов Александр');
  
  console.log('Done.');
}

fixName().catch(console.error).finally(() => prisma.$disconnect());
