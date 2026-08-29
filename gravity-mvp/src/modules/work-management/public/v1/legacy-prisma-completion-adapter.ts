import { prisma } from '@/lib/prisma'
import type { CompleteTaskPersistencePortV1 } from './complete-task-handler'

/** Compatibility adapter for the current ManagerTask resolution write. */
export const legacyPrismaTaskCompletionPortV1: CompleteTaskPersistencePortV1 = {
    async complete({ taskId, outcome, resolvedBy }) {
        await prisma.managerTask.update({
            where: { id: taskId },
            data: {
                status: outcome,
                resolvedAt: new Date(),
                resolvedBy,
            },
        })
    },
}
