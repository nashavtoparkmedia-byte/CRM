import { prisma } from '@/lib/prisma'
import { logTaskEvent } from '@/lib/tasks/task-event-service'
import type { AssignTaskPersistencePortV1 } from './assign-task-handler'

/**
 * Compatibility adapter for the current Task and TaskEvent implementation.
 * Lookup, mutation and event ordering intentionally match the legacy caller.
 */
export const legacyPrismaTaskAssignmentPortV1: AssignTaskPersistencePortV1 = {
    async assign({ taskId, assigneeId, assigneeName }) {
        const task = await prisma.task.findUnique({
            where: { id: taskId },
            select: { id: true, assigneeId: true },
        })
        if (!task) return 'not_found'
        if (task.assigneeId === assigneeId) return 'unchanged'

        const oldAssigneeId = task.assigneeId

        await prisma.task.update({
            where: { id: taskId },
            data: { assigneeId },
        })

        await logTaskEvent(taskId, 'reassigned', {
            from: oldAssigneeId,
            to: assigneeId,
            toName: assigneeName,
        })

        return 'reassigned'
    },
}
