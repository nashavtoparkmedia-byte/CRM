/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

function validateDate(value, field) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) throw new TypeError(`${field} must be a valid Date`)
}
function validateId(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) throw new TypeError(`${field} must be a bounded non-empty string`)
}

async function updateDriverLastOrderAtV1(id, lastOrderAt) {
  validateId(id, 'id'); validateDate(lastOrderAt, 'lastOrderAt')
  const prisma = new PrismaClient()
  try { return await prisma.driver.updateMany({ where: { id, OR: [{ lastOrderAt: null }, { lastOrderAt: { not: lastOrderAt } }] }, data: { lastOrderAt } }) }
  finally { await prisma.$disconnect() }
}

async function clearDriversLastOrderAtV1(activeDriverIds) {
  if (!Array.isArray(activeDriverIds) || activeDriverIds.some(id => typeof id !== 'string')) throw new TypeError('activeDriverIds must be string[]')
  const prisma = new PrismaClient()
  try { return await prisma.driver.updateMany({ where: { id: { notIn: activeDriverIds }, lastOrderAt: { not: null } }, data: { lastOrderAt: null } }) }
  finally { await prisma.$disconnect() }
}

async function resetDriverDaySummaryV1(driverId, startDate, endDate) {
  validateId(driverId, 'driverId'); validateDate(startDate, 'startDate'); validateDate(endDate, 'endDate')
  const prisma = new PrismaClient()
  try { return await prisma.driverDaySummary.updateMany({ where: { driverId, date: { gte: startDate, lte: endDate } }, data: { tripCount: 0 } }) }
  finally { await prisma.$disconnect() }
}

async function upsertDriverDaySummaryV1(driverId, date, tripCount) {
  validateId(driverId, 'driverId'); validateDate(date, 'date'); if (!Number.isInteger(tripCount) || tripCount < 0) throw new TypeError('tripCount must be a non-negative integer')
  const prisma = new PrismaClient()
  try { return await prisma.driverDaySummary.upsert({ where: { driverId_date: { driverId, date } }, update: { tripCount }, create: { driverId, date, tripCount } }) }
  finally { await prisma.$disconnect() }
}

module.exports = { updateDriverLastOrderAtV1, clearDriversLastOrderAtV1, resetDriverDaySummaryV1, upsertDriverDaySummaryV1 }
