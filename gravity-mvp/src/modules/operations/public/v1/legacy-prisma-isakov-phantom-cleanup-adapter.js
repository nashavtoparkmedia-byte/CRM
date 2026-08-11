/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const REAL_PHONE_ID = 'cmnjf14sf01czvp08cb2qagcz'
const LID_IDENTITY_ID = 'cmphc72s3000hvpsksmgk55jr'
const CUS_IDENTITY_ID = 'cmph1e54l00ftvpm4ia9xlrvn'
const LEGACY_CHAT_ID = 'cmph1e53500fovpm430zke5me'

/** Operations-owned fixed, transactional Isakov phantom cleanup. */
async function cleanupIsakovPhantomV1() {
  const prisma = new PrismaClient()
  try {
    return await prisma.$transaction(async (tx) => {
      const lid = await tx.contactIdentity.update({ where: { id: LID_IDENTITY_ID }, data: { phoneId: REAL_PHONE_ID } })
      const cus = await tx.contactIdentity.update({ where: { id: CUS_IDENTITY_ID }, data: { isActive: false, phoneId: null } })
      const chat = await tx.chat.update({ where: { id: LEGACY_CHAT_ID }, data: { status: 'resolved' } })
      return { lid, cus, chat }
    })
  } finally { await prisma.$disconnect() }
}
module.exports = { cleanupIsakovPhantomV1 }
