import { prisma } from '@/lib/prisma'
import type { CreateTaskPersistencePortV1 } from './create-task-handler'
import { mapCreateTaskDataToLegacyRecordV1 } from './legacy-task-record'

/**
 * Compatibility adapter for the current monolith persistence model.
 * The versioned command and handler stay independent of Prisma; only this
 * owner-context adapter knows the legacy storage implementation.
 */
export const legacyPrismaTaskPortV1: CreateTaskPersistencePortV1 = {
    async create(data) {
        return prisma.task.create({
            data: mapCreateTaskDataToLegacyRecordV1(data),
            select: {
                id: true,
                title: true,
            },
        })
    },
}
