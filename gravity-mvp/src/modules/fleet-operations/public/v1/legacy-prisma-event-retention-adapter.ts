import { prisma } from '@/lib/prisma'
import type { FleetEventRetentionPersistencePortV1 } from './event-retention-handler'

export const legacyPrismaFleetEventRetentionPortV1: FleetEventRetentionPersistencePortV1 = {
  async runDriverEventRetention({ dryRun }) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "DriverEvent"
      WHERE "createdAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '180 days'
      ORDER BY "createdAt" ASC
      LIMIT 100
    `
    if (dryRun || rows.length === 0) return { selectedCount: rows.length }

    const ids = rows.map(row => row.id)
    await prisma.$executeRaw`DELETE FROM "DriverEvent" WHERE id = ANY(${ids}::text[])`
    return { selectedCount: ids.length }
  },

  async runApiLogRetention({ dryRun }) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "ApiLog"
      WHERE "createdAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '30 days'
      ORDER BY "createdAt" ASC
      LIMIT 100
    `
    if (dryRun || rows.length === 0) return { selectedCount: rows.length }

    const ids = rows.map(row => row.id)
    await prisma.$executeRaw`DELETE FROM "ApiLog" WHERE id = ANY(${ids}::text[])`
    return { selectedCount: ids.length }
  },
}
