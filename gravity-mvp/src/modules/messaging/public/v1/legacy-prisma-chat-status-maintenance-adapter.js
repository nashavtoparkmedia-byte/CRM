/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const LEGACY_CHAT_ID = 'cmph1e53500fovpm430zke5me'

/** Messaging-owned fixed Isakov legacy-chat status repair. */
async function resolveIsakovLegacyChatV1() {
  const prisma = new PrismaClient()
  try { return await prisma.chat.update({ where: { id: LEGACY_CHAT_ID }, data: { status: 'resolved' } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { resolveIsakovLegacyChatV1 }
