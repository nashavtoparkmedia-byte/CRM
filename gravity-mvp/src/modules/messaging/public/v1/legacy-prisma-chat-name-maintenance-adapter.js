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

/** Messaging-owned exact repair for a known chat identity. */
async function repairChatIdentityV1(chatId, driverId, name) {
  validateText(chatId, 'chatId'); validateText(driverId, 'driverId'); validateText(name, 'name')
  const prisma = new PrismaClient()
  try { return await prisma.chat.update({ where: { id: chatId }, data: { driverId, name } }) }
  finally { await prisma.$disconnect() }
}

/** Messaging-owned bounded MAX prefix cleanup. */
async function stripMaxChatPrefixV1(chatId, name) {
  validateText(chatId, 'chatId'); validateText(name, 'name')
  const prisma = new PrismaClient()
  try { return await prisma.chat.update({ where: { id: chatId }, data: { name } }) }
  finally { await prisma.$disconnect() }
}

/** Messaging-owned sibling-derived chat repair. */
async function backfillSiblingChatV1(chatId, data) {
  validateText(chatId, 'chatId')
  if (!data || typeof data !== 'object' || typeof data.name !== 'string' || !data.name.trim()) throw new TypeError('name is required')
  const update = { name: data.name }
  if (data.driverId != null) { validateText(data.driverId, 'driverId'); update.driverId = data.driverId }
  const prisma = new PrismaClient()
  try { return await prisma.chat.update({ where: { id: chatId }, data: update }) }
  finally { await prisma.$disconnect() }
}

module.exports = { restoreChatDisplayNameV1, repairChatIdentityV1, stripMaxChatPrefixV1, backfillSiblingChatV1 }
