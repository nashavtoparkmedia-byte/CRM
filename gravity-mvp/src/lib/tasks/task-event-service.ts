import { cookies } from 'next/headers'
import { prisma } from '@/lib/prisma'

/**
 * Append-only audit log for task events.
 * Every significant action on a task should go through this service.
 */
export async function logTaskEvent(
    taskId: string,
    eventType: string,
    payload: Record<string, unknown> = {},
    actor?: { type: 'system' | 'user' | 'auto'; id?: string }
) {
    const cookieStore = await cookies();
    const userId = cookieStore.get('crm_user_id')?.value;

    return prisma.taskEvent.create({
        data: {
            taskId,
            eventType,
            payload: payload as any,
            actorType: userId ? 'user' : (actor?.type || 'system'),
            actorId: userId || actor?.id || null,
        },
    });
}

/**
 * Get task event history (most recent first).
 */
export async function getTaskEvents(taskId: string, limit = 50) {
    return prisma.taskEvent.findMany({
        where: { taskId },
        orderBy: { createdAt: 'desc' },
        take: limit,
    })
}
