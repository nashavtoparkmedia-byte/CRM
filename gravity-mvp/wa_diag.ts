import { PrismaClient } from '@prisma/client'
import fs from 'fs'

const prisma = new PrismaClient()

async function main() {
  console.log('--- Checking Chats ---');
  const chats = await prisma.chat.findMany({
    where: {
      OR: [
        { externalChatId: { contains: '79222155750' } }
      ]
    },
    include: {
      driver: true,
      messages: {
        orderBy: { sentAt: 'desc' },
        take: 5
      }
    }
  })

  console.log(JSON.stringify(chats, null, 2))

  console.log('\n--- Checking Raw Message Records for 2342 and 2343 ---');
  const msgs = await prisma.message.findMany({
    where: {
      content: { in: ['2342', '2343'] }
    },
    include: { chat: true }
  })
  console.log(JSON.stringify(msgs, null, 2))

  fs.writeFileSync('C:/Users/mixx/Documents/Github/CRM/gravity-mvp/wa_diag.json', JSON.stringify({ chats, msgs }, null, 2));
}

main().catch(console.error).finally(() => prisma.$disconnect())
