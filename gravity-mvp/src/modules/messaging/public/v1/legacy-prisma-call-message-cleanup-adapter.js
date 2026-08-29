/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
async function deleteCallMessagesV1() {
  const prisma = new PrismaClient()
  try { return await prisma.message.deleteMany({ where: { type: 'call' } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { deleteCallMessagesV1 }
