/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Messaging-owned fixed maintenance capabilities for Chat backfills. */
async function backfillLastInboundAtV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.$executeRaw`
      UPDATE "Chat" c
      SET "lastInboundAt" = sub."maxInbound"
      FROM (
        SELECT m."chatId", MAX(m."sentAt") AS "maxInbound"
        FROM "Message" m
        WHERE m.direction = 'inbound'
        GROUP BY m."chatId"
      ) sub
      WHERE c.id = sub."chatId"
        AND (c."lastInboundAt" IS NULL OR c."lastInboundAt" < sub."maxInbound")
    `
  } finally {
    await prisma.$disconnect()
  }
}

async function backfillUnreadCountV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.$executeRaw`
      UPDATE "Chat" c
      SET "unreadCount" = sub."unreadCount"
      FROM (
        SELECT m."chatId", COUNT(*) AS "unreadCount"
        FROM "Message" m
        WHERE m.direction = 'inbound'
          AND m."sentAt" > COALESCE(
            (SELECT MAX(m2."sentAt") FROM "Message" m2
             WHERE m2."chatId" = m."chatId" AND m2.direction = 'outbound'),
            '1970-01-01'::timestamptz
          )
        GROUP BY m."chatId"
      ) sub
      WHERE c.id = sub."chatId"
        AND c."unreadCount" = 0
        AND sub."unreadCount" > 0
    `
  } finally {
    await prisma.$disconnect()
  }
}

async function deleteUnifiedMessagesByIdsV1(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('ids must be string[]')
  const prisma = new PrismaClient(); try { return await prisma.message.deleteMany({ where: { id: { in: ids } } }) } finally { await prisma.$disconnect() }
}
async function markBackfilledOutboundDeliveredV1() {
  const prisma = new PrismaClient(); try { return await prisma.message.updateMany({ where: { channel: 'whatsapp', direction: 'outbound', externalId: { not: null }, status: { in: ['failed', 'sent', 'queued'] } }, data: { status: 'delivered' } }) } finally { await prisma.$disconnect() }
}
async function deleteEmptyUnifiedChatsV1(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('ids must be string[]')
  const prisma = new PrismaClient(); try { return await prisma.chat.deleteMany({ where: { id: { in: ids } } }) } finally { await prisma.$disconnect() }
}

module.exports = { backfillLastInboundAtV1, backfillUnreadCountV1, deleteUnifiedMessagesByIdsV1, markBackfilledOutboundDeliveredV1, deleteEmptyUnifiedChatsV1 }
