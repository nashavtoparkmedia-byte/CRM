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
module.exports = { repairWhatsAppMessageTimestampV1 }
