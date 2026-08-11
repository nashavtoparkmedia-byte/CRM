/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
const REAL_PHONE_ID = 'cmnjf1h8n09sjvp080h2z4pmm'
const LID_IDENTITY_ID = 'cmpgm9ku500g5vpc0p9f4a5l1'
const CUS_IDENTITY_ID = 'cmping75o000xvpp055983rua'
async function cleanupMegrabyanIdentitiesV1() {
  const prisma = new PrismaClient()
  try {
    const lid = await prisma.contactIdentity.update({ where: { id: LID_IDENTITY_ID }, data: { phoneId: REAL_PHONE_ID } })
    const cus = await prisma.contactIdentity.update({ where: { id: CUS_IDENTITY_ID }, data: { isActive: false, phoneId: null } })
    return { lid, cus }
  } finally { await prisma.$disconnect() }
}
module.exports = { cleanupMegrabyanIdentitiesV1 }
