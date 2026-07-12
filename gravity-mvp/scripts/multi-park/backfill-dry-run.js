#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-require-imports */
const { PrismaClient } = require('@prisma/client')
const prisma = new PrismaClient()

const APPROVED_PARKS = ['Наш Автопарк', 'YOKO', 'YOKO-2', 'YOKO-3', 'YOKO-4', 'YOKO.Доставка']

async function main() {
  const [total, withPark, linked, ambiguousPhones, connections] = await Promise.all([
    prisma.driver.count(),
    prisma.driver.count({ where: { lastExternalPark: { not: null } } }),
    prisma.driver.count({ where: { contactId: { not: null } } }),
    prisma.$queryRaw`SELECT phone, COUNT(DISTINCT "contactId")::int AS contacts FROM "ContactPhone" WHERE "isActive" = true AND phone IS NOT NULL GROUP BY phone HAVING COUNT(DISTINCT "contactId") > 1`,
    prisma.apiConnection.findMany({ select: { parkId: true, name: true }, orderBy: { createdAt: 'asc' } }),
  ])
  const byPark = await prisma.driver.groupBy({ by: ['lastExternalPark'], _count: { _all: true } })
  const withoutPark = total - withPark
  const unlinked = total - linked
  const parkCoverage = APPROVED_PARKS.map((park) => {
    const row = byPark.find((item) => item.lastExternalPark === park)
    return { park, driverProfiles: row?._count?._all || 0 }
  })
  const unknownParks = byPark.filter((item) => item.lastExternalPark && !APPROVED_PARKS.includes(item.lastExternalPark))
  const result = {
    mode: 'dry-run',
    generatedAt: new Date().toISOString(),
    totals: {
      driverProfiles: total,
      withPark,
      withoutPark,
      linked,
      unlinked,
      ambiguousPhones: ambiguousPhones.length,
      anomalies: unknownParks.length,
      manualReview: withoutPark + ambiguousPhones.length + unknownParks.length,
      errors: 0,
    },
    apiConnections: connections.map((connection) => ({ parkId: connection.parkId, name: connection.name || connection.parkId })),
    approvedParkCoverage: parkCoverage,
    unknownParks,
    actions: [],
    safety: {
      writes: false,
      linksByName: false,
      deletesDrivers: false,
      deletesContacts: false,
      randomMerge: false,
      historicalProfilesPreserved: true,
    },
  }
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ mode: 'dry-run', error: err.message }, null, 2))
  process.exitCode = 1
}).finally(async () => prisma.$disconnect())
