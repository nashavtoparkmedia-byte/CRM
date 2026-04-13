'use server'

import { prisma } from '@/lib/prisma'
import { cookies } from 'next/headers'

export interface DailyTask {
    id: string
    title: string
    driverName: string
    driverPhone: string | null
    driverId: string
    scenario: string | null
    stage: string | null
    status: string
    priority: string
    dueAt: string | null
    slaDeadline: string | null
    isOverdue: boolean
    isSlaBreached: boolean
    attempts: number
}

export interface DailySummary {
    today: DailyTask[]
    overdue: DailyTask[]
    active: DailyTask[]
    metrics: {
        total: number
        overdue: number
        closedToday: number
        createdToday: number
    }
}

function toDailyTask(t: any, now: Date): DailyTask {
    const meta = (t.metadata as Record<string, any>) || {}
    const dueAt = t.dueAt ? t.dueAt.toISOString() : null
    const slaDeadline = t.slaDeadline ? t.slaDeadline.toISOString() : null
    return {
        id: t.id,
        title: t.title,
        driverName: t.driver?.fullName || 'Неизвестный',
        driverPhone: t.driver?.phone || null,
        driverId: t.driverId,
        scenario: t.scenario,
        stage: t.stage,
        status: t.status,
        priority: t.priority,
        dueAt,
        slaDeadline,
        isOverdue: !!(t.dueAt && t.dueAt < now && t.isActive),
        isSlaBreached: !!(t.slaDeadline && t.slaDeadline < now && t.isActive),
        attempts: meta.attempts || 0,
    }
}

export async function getDailySummary(): Promise<DailySummary> {
    const cookieStore = await cookies()
    const userId = cookieStore.get('crm_user_id')?.value || null

    const now = new Date()
    const todayStart = new Date(now)
    todayStart.setHours(0, 0, 0, 0)
    const todayEnd = new Date(now)
    todayEnd.setHours(23, 59, 59, 999)

    const include = {
        driver: { select: { fullName: true, phone: true } },
    }

    // 1. Tasks due today (for current user if known, otherwise all)
    const assigneeFilter = userId ? { assigneeId: userId } : {}

    const todayTasks = await prisma.task.findMany({
        where: {
            isActive: true,
            dueAt: { gte: todayStart, lte: todayEnd },
            ...assigneeFilter,
        },
        include,
        orderBy: { dueAt: 'asc' },
    })

    // 2. Overdue tasks
    const overdueTasks = await prisma.task.findMany({
        where: {
            isActive: true,
            OR: [
                { dueAt: { lt: now } },
                { slaDeadline: { lt: now } },
            ],
            // Exclude today's tasks that are due later today
            NOT: { dueAt: { gte: todayStart, lte: todayEnd } },
            ...assigneeFilter,
        },
        include,
        orderBy: { dueAt: 'asc' },
    })

    // 3. All active tasks for this user
    const activeTasks = await prisma.task.findMany({
        where: {
            isActive: true,
            ...assigneeFilter,
        },
        include,
        orderBy: [{ priority: 'asc' }, { dueAt: 'asc' }],
    })

    // 4. Metrics
    const [totalActive, overdueCount, closedToday, createdToday] = await Promise.all([
        prisma.task.count({
            where: { isActive: true, ...assigneeFilter },
        }),
        prisma.task.count({
            where: {
                isActive: true,
                dueAt: { lt: now },
                ...assigneeFilter,
            },
        }),
        prisma.task.count({
            where: {
                status: { in: ['done', 'cancelled'] },
                resolvedAt: { gte: todayStart, lte: todayEnd },
                ...assigneeFilter,
            },
        }),
        prisma.task.count({
            where: {
                createdAt: { gte: todayStart, lte: todayEnd },
                ...assigneeFilter,
            },
        }),
    ])

    return {
        today: todayTasks.map(t => toDailyTask(t, now)),
        overdue: overdueTasks.map(t => toDailyTask(t, now)),
        active: activeTasks.map(t => toDailyTask(t, now)),
        metrics: {
            total: totalActive,
            overdue: overdueCount,
            closedToday,
            createdToday,
        },
    }
}
