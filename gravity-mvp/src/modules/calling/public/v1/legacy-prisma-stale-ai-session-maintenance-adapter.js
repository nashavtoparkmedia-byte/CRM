/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Calling-owned exact repair for one stale AI session. */
async function updateStaleAiSessionV1({ id, endedAt, metadata }) {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('id must be bounded text')
  if (!(endedAt instanceof Date) || Number.isNaN(endedAt.getTime())) throw new TypeError('endedAt must be a valid Date')
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new TypeError('metadata must be an object')
  const prisma = new PrismaClient()
  try {
    return await prisma.call.update({
      where: { id },
      data: { aiSessionStatus: 'failed', endedAt, hangupCause: 'AI_SESSION_STALE_CLEANUP', metadata },
    })
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { updateStaleAiSessionV1 }
