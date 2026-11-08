import { prisma } from '@/lib/prisma'
import type { ChurnInactivityPersistencePortV1 } from './churn-inactivity-trigger-handler'

// Fleet-owned read of Driver activity for the Отток trigger. One bounded read,
// Fleet-owned columns only, no write.
export const legacyPrismaChurnInactivityPortV1: ChurnInactivityPersistencePortV1 = {
    async findInactiveDrivers({ threshold, limit }) {
        const rows = await prisma.driver.findMany({
            where: { dismissedAt: null, lastOrderAt: { not: null, lte: threshold } },
            select: { id: true, contactId: true, fullName: true, lastOrderAt: true },
            orderBy: [{ lastOrderAt: 'asc' }, { id: 'asc' }],
            take: limit,
        })
        return rows.flatMap((row) => row.lastOrderAt
            ? [{ id: row.id, contactId: row.contactId, fullName: row.fullName, lastOrderAt: row.lastOrderAt }]
            : [])
    },
}
