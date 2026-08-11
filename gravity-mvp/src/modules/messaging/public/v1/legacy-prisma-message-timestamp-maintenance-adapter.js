/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date`)
}
function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be a bounded non-empty string`)
}

/** Messaging-owned exact repair for unified WhatsApp message timestamps. */
async function repairMessageSentAtV1(id, sentAt) {
  validateId(id, 'id'); validateDate(sentAt, 'sentAt')
  const prisma = new PrismaClient()
  try { return await prisma.message.update({ where: { id }, data: { sentAt } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { repairMessageSentAtV1 }
