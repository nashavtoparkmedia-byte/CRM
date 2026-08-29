/* eslint-disable @typescript-eslint/no-require-imports */

const { PrismaClient } = require('@prisma/client')

/** Work Management-owned capability for the exact legacy epoch-date cleanup. */
async function clearEpochTaskDatesV1() {
  const prisma = new PrismaClient()
  try {
    const nextActionAt = await prisma.$executeRaw`
      UPDATE tasks SET "nextActionAt" = NULL
      WHERE "nextActionAt" IS NOT NULL AND "nextActionAt" < TIMESTAMPTZ '2010-01-01 00:00:00+00'
    `
    const dueAt = await prisma.$executeRaw`
      UPDATE tasks SET "dueAt" = NULL
      WHERE "dueAt" IS NOT NULL AND "dueAt" < TIMESTAMPTZ '2010-01-01 00:00:00+00'
    `
    const slaDeadline = await prisma.$executeRaw`
      UPDATE tasks SET "slaDeadline" = NULL
      WHERE "slaDeadline" IS NOT NULL AND "slaDeadline" < TIMESTAMPTZ '2010-01-01 00:00:00+00'
    `
    return { nextActionAt, dueAt, slaDeadline }
  } finally {
    await prisma.$disconnect()
  }
}

module.exports = { clearEpochTaskDatesV1 }
