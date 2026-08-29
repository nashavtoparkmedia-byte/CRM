import { prisma } from '@/lib/prisma'
import type { CommunicationEventRetentionPersistencePortV1 } from './communication-event-retention-handler'

export const legacyPrismaCommunicationEventRetentionPortV1:
  CommunicationEventRetentionPersistencePortV1 = {
  async runCommunicationEventRetention({ dryRun }) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM "CommunicationEvent"
      WHERE "createdAt" < (NOW() AT TIME ZONE 'UTC') - INTERVAL '180 days'
      ORDER BY "createdAt" ASC
      LIMIT 100
    `
    if (dryRun || rows.length === 0) return { selectedCount: rows.length }

    const ids = rows.map(row => row.id)
    await prisma.communicationEvent.deleteMany({ where: { id: { in: ids } } })
    return { selectedCount: ids.length }
  },
}
