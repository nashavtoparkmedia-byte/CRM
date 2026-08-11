/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateText(value, field) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512) throw new TypeError(`${field} must be bounded text`)
}

/** Messaging-owned exact Chat display-name repair. */
async function restoreChatDisplayNameV1(externalChatId, name) {
  validateText(externalChatId, 'externalChatId')
  validateText(name, 'name')
  const prisma = new PrismaClient()
  try {
    return await prisma.chat.update({ where: { externalChatId }, data: { name } })
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { restoreChatDisplayNameV1 }
