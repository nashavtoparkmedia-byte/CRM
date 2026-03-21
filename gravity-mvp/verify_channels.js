require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  console.log('--- VERIFYING MESSAGE CHANNELS ---')
  const sample = await prisma.message.findMany({
    take: 10,
    orderBy: { sentAt: 'desc' },
    select: { id: true, content: true, channel: true, status: true }
  })
  
  console.table(sample)

  const nullCount = await prisma.message.count({ where: { channel: null } })
  console.log(`Remaining messages with NULL channel: ${nullCount}`)
}

main().catch(console.error).finally(() => prisma.$disconnect())
