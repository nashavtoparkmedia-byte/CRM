import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { DriverActionPersistencePortV1 } from './driver-action-handler'

export const legacyPrismaDriverActionPortV1: DriverActionPersistencePortV1 = {
    async create(data) {
        return prisma.driverAction.create({ data })
    },
    async mirrorResult(input) {
        const result = await prisma.driverAction.updateMany({
            where: { scraperTaskId: input.scraperTaskId, status: 'PENDING' },
            data: {
                status: input.status,
                result: input.result as Prisma.InputJsonValue | undefined,
                errorMessage: input.errorMessage,
                shortOrderId: input.shortOrderId,
                orderId: input.orderId,
                completedAt: input.completedAt,
            },
        })
        return { updatedCount: result.count }
    },
}
