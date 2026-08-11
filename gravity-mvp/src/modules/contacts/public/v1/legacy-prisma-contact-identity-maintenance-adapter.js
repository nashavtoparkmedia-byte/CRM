/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateId(value, field) { if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be a bounded non-empty string`) }
function validateDate(value) { if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError('checkedAt must be a valid Date') }

async function updateContactIdentityReachabilityV1(id, status, checkedAt) {
  validateId(id, 'id'); validateId(status, 'status'); validateDate(checkedAt)
  const prisma = new PrismaClient()
  try { return await prisma.contactIdentity.update({ where: { id }, data: { reachabilityStatus: status, reachabilityCheckedAt: checkedAt } }) }
  finally { await prisma.$disconnect() }
}

async function deactivateFakeContactIdentityV1(id) {
  validateId(id, 'id')
  const prisma = new PrismaClient()
  try { return await prisma.contactIdentity.update({ where: { id }, data: { isActive: false, phoneId: null } }) }
  finally { await prisma.$disconnect() }
}

const REAL_PHONE_ID = 'cmnjf14sf01czvp08cb2qagcz'
const LID_IDENTITY_ID = 'cmphc72s3000hvpsksmgk55jr'
const CUS_IDENTITY_ID = 'cmph1e54l00ftvpm4ia9xlrvn'
async function repointIsakovLidIdentityV1() {
  const prisma = new PrismaClient()
  try { return await prisma.contactIdentity.update({ where: { id: LID_IDENTITY_ID }, data: { phoneId: REAL_PHONE_ID } }) }
  finally { await prisma.$disconnect() }
}
async function deactivateIsakovCusIdentityV1() {
  const prisma = new PrismaClient()
  try { return await prisma.contactIdentity.update({ where: { id: CUS_IDENTITY_ID }, data: { isActive: false, phoneId: null } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { updateContactIdentityReachabilityV1, deactivateFakeContactIdentityV1, repointIsakovLidIdentityV1, deactivateIsakovCusIdentityV1 }
