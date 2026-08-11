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
module.exports = { updateContactIdentityReachabilityV1, deactivateFakeContactIdentityV1 }
