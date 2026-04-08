'use strict'
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  const oldest = await prisma.$queryRaw`
    SELECT "sentAt", content, "chatId"
    FROM "Message"
    WHERE channel = 'max'
    ORDER BY "sentAt" ASC
    LIMIT 5
  `
  console.log('Самые старые MAX-сообщения:')
  for (const r of oldest) console.log(' ', r.sentAt, '|', r.content?.slice(0, 40))

  const newest = await prisma.$queryRaw`
    SELECT "sentAt", content
    FROM "Message"
    WHERE channel = 'max'
    ORDER BY "sentAt" DESC
    LIMIT 5
  `
  console.log('\nСамые новые MAX-сообщения:')
  for (const r of newest) console.log(' ', r.sentAt, '|', r.content?.slice(0, 40))

  const stats = await prisma.$queryRaw`
    SELECT COUNT(*) as total,
           MIN("sentAt") as min_date,
           MAX("sentAt") as max_date
    FROM "Message"
    WHERE channel = 'max'
  `
  console.log('\nИтого:', stats[0])
  process.exit(0)
}
main().catch(e => { console.error(e.message); process.exit(1) })
