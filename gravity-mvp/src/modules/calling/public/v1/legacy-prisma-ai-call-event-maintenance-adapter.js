/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Calling-owned append-only capability for validated AiCallEvent rows. */
async function insertAiCallEventsV1(data) {
  if (!Array.isArray(data) || data.length === 0) return { count: 0 }
  const prisma = new PrismaClient()
  try {
    return await prisma.aiCallEvent.createMany({ data, skipDuplicates: true })
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { insertAiCallEventsV1 }
