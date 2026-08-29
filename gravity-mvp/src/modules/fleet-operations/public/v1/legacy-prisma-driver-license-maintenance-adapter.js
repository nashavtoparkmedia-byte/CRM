/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')
function validateText(value, field) { if (typeof value !== 'string' || value.trim().length === 0 || value.length > 256) throw new TypeError(`${field} must be bounded text`) }
async function updateDriverLicenseV1(yandexDriverId, licenseNumber) {
  validateText(yandexDriverId, 'yandexDriverId'); validateText(licenseNumber, 'licenseNumber')
  const prisma = new PrismaClient()
  try { return await prisma.driver.updateMany({ where: { yandexDriverId }, data: { licenseNumber } }) }
  finally { await prisma.$disconnect() }
}
module.exports = { updateDriverLicenseV1 }
