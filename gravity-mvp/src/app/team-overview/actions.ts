'use server'

import { prisma } from '@/lib/prisma'
import { logTaskEvent } from '@/lib/tasks/task-event-service'
import { isManagerOverloaded } from '@/lib/tasks/workload-config'

export interface ManagerNextTask {
    id: string
    title: string
    driverName: string
    driverId: string
    scenario: string | null
    stage: string | null
    priority: string
    dueAt: string | null
    isOverdue: boolean
    isSlaBreached: boolean
}

export interface ManagerStats {
    managerId: string
    managerName: string
    role: string
    active: number
    overdue: number
    highPriority: number
    closedToday: number
    isOverloaded: boolean
    nextTask: ManagerNextTask | null
}

export interface TeamOverview {
    totals: {
        active: number
        overdue: number
        highPriority: number
        closedToday: number
    }
    managers: ManagerStats[]
}

export async function getTeamOverview(): Promise<TeamOverview> {
    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(now)
    todayEnd.setHours(23, 59, 59, 999)

    // Get all active CRM users
    const users = await prisma.crmUser.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, role: true },
    })

    if (users.length === 0) {
        return {
            totals: { active: 0, overdue: 0, highPriority: 0, closedToday: 0 },
            managers: [],
        }
    }

    const userIds = users.map(u => u.id)

    // Batch: all assigned active tasks
    const activeTasks = await prisma.task.findMany({
        where: {
            isActive: true,
            assigneeId: { in: userIds },
        },
        select: {
            id: true,
            assigneeId: true,
            priority: true,
            dueAt: true,
            slaDeadline: true,
            title: true,
            driverId: true,
            scenario: true,
            stage: true,
            driver: { select: { fullName: true } },
        },
    })

    // Batch: closed today per user
    const closedToday = await prisma.task.groupBy({
        by: ['assigneeId'],
        where: {
            status: { in: ['done', 'cancelled'] },
            resolvedAt: { gte: todayStart, lte: todayEnd },
            assigneeId: { in: userIds },
        },
        _count: { id: true },
    })
    const closedMap = new Map(closedToday.map(r => [r.assigneeId, r._count.id]))

    // Build per-manager stats
    const managers: ManagerStats[] = users.map(user => {
        const tasks = activeTasks.filter(t => t.assigneeId === user.id)
        const overdueTasks = tasks.filter(t =>
            (t.dueAt && t.dueAt < now) || (t.slaDeadline && t.slaDeadline < now)
        )
        const highPrioTasks = tasks.filter(t => t.priority === 'high' || t.priority === 'critical')

        // Find next task by priority (overdue first, then high prio, then earliest due)
        const sorted = [...tasks].sort((a, b) => {
            const aOverdue = (a.dueAt && a.dueAt < now) || (a.slaDeadline && a.slaDeadline < now)
            const bOverdue = (b.dueAt && b.dueAt < now) || (b.slaDeadline && b.slaDeadline < now)
            if (aOverdue && !bOverdue) return -1
            if (!aOverdue && bOverdue) return 1
            const aPrio = a.priority === 'high' || a.priority === 'critical' ? 1 : 0
            const bPrio = b.priority === 'high' || b.priority === 'critical' ? 1 : 0
            if (aPrio !== bPrio) return bPrio - aPrio
            const aTime = a.dueAt?.getTime() ?? Infinity
            const bTime = b.dueAt?.getTime() ?? Infinity
            return aTime - bTime
        })

        const next = sorted[0] || null

        return {
            managerId: user.id,
            managerName: user.name,
            role: user.role,
            active: tasks.length,
            overdue: overdueTasks.length,
            highPriority: highPrioTasks.length,
            closedToday: closedMap.get(user.id) || 0,
            isOverloaded: isManagerOverloaded(tasks.length, overdueTasks.length),
            nextTask: next ? {
                id: next.id,
                title: next.title,
                driverName: next.driver?.fullName || 'Неизвестный',
                driverId: next.driverId,
                scenario: next.scenario,
                stage: next.stage,
                priority: next.priority,
                dueAt: next.dueAt?.toISOString() ?? null,
                isOverdue: !!(next.dueAt && next.dueAt < now),
                isSlaBreached: !!(next.slaDeadline && next.slaDeadline < now),
            } : null,
        }
    })

    // Sort: overloaded first, then most overdue, then most active
    managers.sort((a, b) =>
        Number(b.isOverloaded) - Number(a.isOverloaded)
        || b.overdue - a.overdue
        || b.active - a.active
    )

    // Totals
    const totals = {
        active: managers.reduce((s, m) => s + m.active, 0),
        overdue: managers.reduce((s, m) => s + m.overdue, 0),
        highPriority: managers.reduce((s, m) => s + m.highPriority, 0),
        closedToday: managers.reduce((s, m) => s + m.closedToday, 0),
    }

    return { totals, managers }
}

/**
 * Reassign tasks from one manager to another.
 * Logs a 'reassigned' event for each task.
 */
export async function reassignTasks(
    taskIds: string[],
    newAssigneeId: string
): Promise<{ reassigned: number }> {
    if (taskIds.length === 0) return { reassigned: 0 }

    // Verify target user exists
    const targetUser = await prisma.crmUser.findUnique({
        where: { id: newAssigneeId },
        select: { id: true, name: true },
    })
    if (!targetUser) throw new Error('Target user not found')

    let reassigned = 0

    for (const taskId of taskIds) {
        const task = await prisma.task.findUnique({
            where: { id: taskId },
            select: { id: true, assigneeId: true },
        })
        if (!task) continue
        if (task.assigneeId === newAssigneeId) continue // already assigned

        const oldAssigneeId = task.assigneeId

        await prisma.task.update({
            where: { id: taskId },
            data: { assigneeId: newAssigneeId },
        })

        await logTaskEvent(taskId, 'reassigned', {
            from: oldAssigneeId,
            to: newAssigneeId,
            toName: targetUser.name,
        })

        reassigned++
    }

    return { reassigned }
}

/**
 * Get active tasks for a specific manager (for reassign modal).
 */
export async function getManagerActiveTasks(managerId: string) {
    const now = new Date()
    const tasks = await prisma.task.findMany({
        where: {
            isActive: true,
            assigneeId: managerId,
        },
        include: {
            driver: { select: { fullName: true } },
        },
        orderBy: [{ dueAt: 'asc' }],
    })

    return tasks.map(t => ({
        id: t.id,
        title: t.title,
        driverName: t.driver?.fullName || 'Неизвестный',
        scenario: t.scenario,
        stage: t.stage,
        priority: t.priority,
        dueAt: t.dueAt?.toISOString() ?? null,
        isOverdue: !!(t.dueAt && t.dueAt < now),
    }))
}
