import { PrismaClient } from '@prisma/client'
import type { ClearFleetCheckStatusPersistencePortV1 } from './clear-fleet-check-status-handler'

export const legacyPrismaClearFleetCheckStatusPortV1: ClearFleetCheckStatusPersistencePortV1 = {
    async clearAll() {
        const prisma = new PrismaClient()
        try {
            const result = await prisma.driver.updateMany({
                data: { lastFleetCheckStatus: null },
            })
            console.log(`Successfully cleared ${result.count} locks!`)
            return { clearedCount: result.count }
        } finally {
            await prisma.$disconnect()
        }
    },
}
