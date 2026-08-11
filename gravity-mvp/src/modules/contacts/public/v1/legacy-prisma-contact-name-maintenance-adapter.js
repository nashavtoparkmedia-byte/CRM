/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) throw new TypeError(`${field} must be bounded text`)
}

/** Contacts-owned exact display-name repair for legacy backfills. */
async function restoreContactDisplayNameV1(contactId, displayName) {
  validateText(contactId, 'contactId')
  validateText(displayName, 'displayName')
  const prisma = new PrismaClient()
  try {
    return await prisma.contact.update({ where: { id: contactId }, data: { displayName } })
  } finally {
    await prisma.$disconnect()
  }
}
module.exports = { restoreContactDisplayNameV1 }
