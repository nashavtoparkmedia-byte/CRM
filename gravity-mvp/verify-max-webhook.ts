import { PrismaClient } from '@prisma/client'
import fs from 'fs'
import path from 'path'

try {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    const envContent = fs.readFileSync(envPath, 'utf8');
    const matches = envContent.match(/DATABASE_URL=["']?(.+?)["']?(\s|$)/);
    if (matches && matches[1]) {
      process.env.DATABASE_URL = matches[1];
    }
  }
} catch (e) {}

const prisma = new PrismaClient()

async function main() {
  const recentMessages = await prisma.message.findMany({
    where: {
      content: { contains: 'Auto webhook link test - 22:45' }
    },
    include: { chat: { include: { driver: true } } },
    take: 5
  });

  const output = recentMessages.map(m => ({
    id: m.id,
    chatId: m.chatId,
    content: m.content,
    chatData: m.chat ? { name: m.chat.name, externalId: m.chat.externalChatId } : null,
    driverName: m.chat?.driver?.fullName
  }));

  fs.writeFileSync('C:/Users/mixx/Documents/Github/CRM/gravity-mvp/verify.json', JSON.stringify(output, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
