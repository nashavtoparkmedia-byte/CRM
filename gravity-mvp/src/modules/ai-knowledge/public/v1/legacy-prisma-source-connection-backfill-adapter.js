/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/**
 * AI Knowledge-owned maintenance capabilities for the two legacy source
 * provenance backfills. SQL and target columns are fixed; callers cannot
 * provide a model, statement or arbitrary update payload.
 */
async function backfillLegacyWhatsAppSourceConnectionsV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.$executeRaw`
      UPDATE "AiKnowledgeSource" s
      SET "connectionId" = wc."connectionId"
      FROM "Chat" c, "WhatsAppChat" wc
      WHERE s."connectionId" IS NULL
        AND s.channel::text = 'whatsapp'
        AND c.id = s."chatId"
        AND wc.id = c."externalChatId"
    `
  } finally {
    await prisma.$disconnect()
  }
}

async function backfillLegacyTelegramMaxSourceConnectionsV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.$executeRaw`
      UPDATE "AiKnowledgeSource" s
      SET "connectionId" = c.metadata->>'connectionId'
      FROM "Chat" c
      WHERE s."connectionId" IS NULL
        AND s.channel::text IN ('telegram', 'max')
        AND c.id = s."chatId"
        AND c.metadata->>'connectionId' IS NOT NULL
    `
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = {
  backfillLegacyWhatsAppSourceConnectionsV1,
  backfillLegacyTelegramMaxSourceConnectionsV1,
}
