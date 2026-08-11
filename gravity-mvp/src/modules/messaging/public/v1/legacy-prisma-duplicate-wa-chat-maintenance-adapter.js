/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const KEEP_ID = 'cmqfw19gs0002sg2639z1tz9g'
const DEL_ID = 'cmq9z45jy02e9l3243rrql7ik'
const PHONE_EXT = 'whatsapp:79222155750'

/** Messaging-owned fixed duplicate-chat merge and canonical rename. */
async function mergeDuplicateWaChatV1() {
  const prisma = new PrismaClient()
  try {
    const del = await prisma.chat.findUnique({ where: { id: DEL_ID }, select: { id: true } })
    let moved = { count: 0 }
    if (del) {
      moved = await prisma.message.updateMany({ where: { chatId: DEL_ID }, data: { chatId: KEEP_ID } })
      await prisma.chat.delete({ where: { id: DEL_ID } })
    }
    const renamed = await prisma.chat.update({ where: { id: KEEP_ID }, data: { externalChatId: PHONE_EXT } })
    return { moved, renamed }
  } finally { await prisma.$disconnect() }
}
module.exports = { mergeDuplicateWaChatV1 }
