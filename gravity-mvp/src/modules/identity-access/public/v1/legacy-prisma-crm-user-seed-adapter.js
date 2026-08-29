/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
function validateText(value, field) { if (typeof value !== 'string' || value.trim().length === 0 || value.length > 128) throw new TypeError(`${field} must be bounded text`) }
function validateRole(value) { if (!['manager', 'lead'].includes(value)) throw new TypeError('role is not allowed') }
async function createCrmUserV1(name, role) {
  validateText(name, 'name'); validateRole(role)
  const prisma = new PrismaClient()
  try { return await prisma.crmUser.create({ data: { name, role } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { createCrmUserV1 }
