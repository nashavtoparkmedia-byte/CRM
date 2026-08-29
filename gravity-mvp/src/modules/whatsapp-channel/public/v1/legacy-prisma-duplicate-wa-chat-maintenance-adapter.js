/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const OLD_ID = '165193082482905@lid'
const NEW_ID = '79222155750@c.us'
async function repairLegacyDuplicateWaChatV1() {
  const prisma = new PrismaClient()
  try {
    const waChat = await prisma.whatsAppChat.findUnique({ where: { id: OLD_ID } })
    if (!waChat) return { repaired: false }
    await prisma.whatsAppChat.upsert({ where: { id: NEW_ID }, update: { lastMessageAt: waChat.lastMessageAt }, create: { id: NEW_ID, connectionId: waChat.connectionId, lastMessageAt: waChat.lastMessageAt } })
    await prisma.whatsAppMessage.updateMany({ where: { chatId: OLD_ID }, data: { chatId: NEW_ID } })
    await prisma.whatsAppChat.delete({ where: { id: OLD_ID } })
    return { repaired: true }
  } finally { await prisma.$disconnect() }
}
module.exports = { repairLegacyDuplicateWaChatV1 }
