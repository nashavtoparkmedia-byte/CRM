/**
 * Одноразовый бэкфилл: заполняет lastInboundAt для TG/WA/MAX чатов
 * на основе самого позднего входящего сообщения в каждом чате.
 *
 * Запускать: node scripts/backfill_tg_last_inbound_at.js
 */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

async function main() {
    console.log('[BACKFILL] Starting lastInboundAt backfill...')

    const result = await prisma.$executeRaw`
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

    console.log(`[BACKFILL] Updated ${result} chats with lastInboundAt`)
    console.log('[BACKFILL] Done.')
}

main().catch(e => {
    console.error('[BACKFILL] Error:', e.message)
    process.exit(1)
}).finally(() => prisma.$disconnect())
