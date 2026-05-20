const { loadEnvConfig } = require('@next/env')
loadEnvConfig(process.cwd())
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  // Find the 05-15 calls
  const start = new Date('2026-05-15T00:00:00Z')
  const end = new Date('2026-05-16T00:00:00Z')
  const calls = await prisma.call.findMany({
    where: { startedAt: { gte: start, lt: end } },
    orderBy: { startedAt: 'desc' },
    select: { id: true, direction: true, status: true, fromNumber: true, toNumber: true, contactId: true, durationSec: true, hangupCause: true, startedAt: true, endedAt: true },
  })
  console.log(`05-15 calls: ${calls.length}`)
  for (const c of calls) {
    const peer = c.direction === 'inbound' ? c.fromNumber : c.toNumber
    const externalChatId = `phone:${peer}`
    const chat = await prisma.chat.findUnique({ where: { externalChatId } })
    const msg = chat ? await prisma.message.findFirst({
      where: {
        chatId: chat.id,
        type: 'call',
        metadata: { path: ['callId'], equals: c.id },
      },
    }) : null
    console.log(`  ${c.startedAt.toISOString()} ${c.direction} ${c.status} peer=${peer} contactId=${c.contactId} chatFound=${!!chat} msgFound=${!!msg}`)
  }
  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
