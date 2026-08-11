/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128) throw new TypeError(`${field} must be bounded text`)
}

/** Calling-owned exact status repair for a historical Call row. */
async function updateCallStatusV1(id, status) {
  validateText(id, 'id'); validateText(status, 'status')
  const prisma = new PrismaClient()
  try { return await prisma.call.update({ where: { id }, data: { status } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { updateCallStatusV1 }
