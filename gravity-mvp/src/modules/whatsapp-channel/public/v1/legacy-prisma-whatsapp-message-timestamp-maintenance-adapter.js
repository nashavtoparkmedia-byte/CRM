/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateDate(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('timestamp must be a valid Date')
}
function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be a bounded non-empty string`)
}

/** WhatsApp Channel-owned exact repair for legacy WhatsAppMessage rows. */
async function repairWhatsAppMessageTimestampV1(id, chatId, timestamp) {
  validateId(id, 'id'); validateId(chatId, 'chatId'); validateDate(timestamp)
  const prisma = new PrismaClient()
  try { return await prisma.whatsAppMessage.update({ where: { id_chatId: { id, chatId } }, data: { timestamp } }) }
  finally { await prisma.$disconnect() }
}
async function deleteLegacyWhatsAppMessageV1(id, chatId) {
  validateId(id, 'id'); validateId(chatId, 'chatId'); const prisma = new PrismaClient()
  try { return await prisma.whatsAppMessage.delete({ where: { id_chatId: { id, chatId } } }) } finally { await prisma.$disconnect() }
}
async function deleteEmptyLegacyWhatsAppChatsV1(ids) {
  if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('ids must be string[]')
  const prisma = new PrismaClient(); try {
    const roster = await prisma.whatsAppChatRoster.deleteMany({ where: { jid: { in: ids } } })
    const chats = await prisma.whatsAppChat.deleteMany({ where: { id: { in: ids } } })
    return { roster, chats }
  } finally { await prisma.$disconnect() }
}
module.exports = { repairWhatsAppMessageTimestampV1, deleteLegacyWhatsAppMessageV1, deleteEmptyLegacyWhatsAppChatsV1 }
