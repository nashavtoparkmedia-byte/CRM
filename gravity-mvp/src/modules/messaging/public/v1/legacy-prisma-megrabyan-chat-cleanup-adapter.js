/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const CHAT_A_ID = 'cmpgm9kt800g0vpc0h807vgb7'
const CHAT_B_ID = 'cmpjak25e000bvpf05myukjj6'
const CORRECT_LID_EXT = '253292038910130@lid'
async function cleanupMegrabyanChatsV1() {
  const prisma = new PrismaClient()
  try {
    const migrated = await prisma.message.updateMany({ where: { chatId: CHAT_B_ID }, data: { chatId: CHAT_A_ID } })
    await prisma.chat.update({ where: { id: CHAT_B_ID }, data: { externalChatId: `__deleted_${CHAT_B_ID}` } })
    await prisma.chat.delete({ where: { id: CHAT_B_ID } })
    const renamed = await prisma.chat.update({ where: { id: CHAT_A_ID }, data: { externalChatId: CORRECT_LID_EXT } })
    return { migrated, renamed }
  } finally { await prisma.$disconnect() }
}
module.exports = { cleanupMegrabyanChatsV1 }
