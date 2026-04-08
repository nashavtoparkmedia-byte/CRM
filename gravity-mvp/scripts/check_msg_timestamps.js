'use strict'

const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
  // Смотрим реальные timestamps сообщений в БД (таблица Message или UnifiedMessage)
  let rows

  try {
    rows = await prisma.$queryRaw`
      SELECT "sentAt", "externalId", "chatId"
      FROM "Message"
      ORDER BY "sentAt" ASC
      LIMIT 5
    `
    console.log('Таблица Message — самые старые:')
    for (const r of rows) console.log(' ', r.sentAt, '| chat:', r.chatId, '| ext:', r.externalId)

    const newest = await prisma.$queryRaw`
      SELECT "sentAt" FROM "Message" ORDER BY "sentAt" DESC LIMIT 3
    `
    console.log('Самые новые:')
    for (const r of newest) console.log(' ', r.sentAt)
  } catch (e) {
    console.log('Message не найдена:', e.message)
  }

  try {
    rows = await prisma.$queryRaw`
      SELECT "sentAt", "externalId", "chatId"
      FROM "UnifiedMessage"
      ORDER BY "sentAt" ASC
      LIMIT 5
    `
    console.log('\nТаблица UnifiedMessage — самые старые:')
    for (const r of rows) console.log(' ', r.sentAt, '| chat:', r.chatId)

    const newest = await prisma.$queryRaw`
      SELECT "sentAt" FROM "UnifiedMessage" ORDER BY "sentAt" DESC LIMIT 3
    `
    console.log('Самые новые:')
    for (const r of newest) console.log(' ', r.sentAt)
  } catch (e) {
    console.log('UnifiedMessage не найдена:', e.message)
  }

  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
