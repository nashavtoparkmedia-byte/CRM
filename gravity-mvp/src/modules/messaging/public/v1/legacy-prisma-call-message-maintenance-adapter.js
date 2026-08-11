/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be bounded text`)
}
function validateMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('metadata must be an object')
}

/** Messaging-owned exact repair for call-type Message content and metadata. */
async function updateCallMessageV1(id, content, metadata) {
  validateText(id, 'id'); validateText(content, 'content'); validateMetadata(metadata)
  const prisma = new PrismaClient()
  try { return await prisma.message.update({ where: { id }, data: { content, metadata } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { updateCallMessageV1 }
