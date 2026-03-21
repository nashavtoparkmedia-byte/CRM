'use server'

import { prisma } from '@/lib/prisma'
import { revalidatePath } from 'next/cache'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface InboxTask {
    id: string
    driverId: string
    driverName: string
    driverPhone: string | null
    driverSegment: string
    type: string
    title: string
    priority: string
    status: string
    triggerId: string | null
    createdAt: string
}

export interface InboxResult {
    tasks: InboxTask[]
    total: number
    counts: {
        high: number
        medium: number
        low: number
        total: number
    }
}

// ─── Actions ────────────────────────────────────────────────────────────────

export async function getManagerTasks(
    filters: {
        status?: string
        priority?: string
        search?: string
    } = {},
    page: number = 1,
    limit: number = 30
): Promise<InboxResult> {
    const where: any = {}

    if (filters.status && filters.status !== 'all') {
        where.status = filters.status
    } else {
        where.status = 'open'  // default to open tasks
    }

    if (filters.priority && filters.priority !== 'all') {
        where.priority = filters.priority
    }

    if (filters.search) {
        where.driver = {
            fullName: { contains: filters.search, mode: 'insensitive' },
        }
    }

    const [tasks, total, highCount, mediumCount, lowCount] = await Promise.all([
        prisma.managerTask.findMany({
            where,
            orderBy: [
                { priority: 'asc' },  // high before medium before low
                { createdAt: 'desc' },
            ],
            skip: (page - 1) * limit,
            take: limit,
            include: {
                driver: {
                    select: { fullName: true, phone: true, segment: true },
                },
            },
        }),
        prisma.managerTask.count({ where }),
        prisma.managerTask.count({ where: { status: 'open', priority: 'high' } }),
        prisma.managerTask.count({ where: { status: 'open', priority: 'medium' } }),
        prisma.managerTask.count({ where: { status: 'open', priority: 'low' } }),
    ])

    return {
        tasks: tasks.map(t => ({
            id: t.id,
            driverId: t.driverId,
            driverName: t.driver.fullName,
            driverPhone: t.driver.phone,
            driverSegment: t.driver.segment,
            type: t.type,
            title: t.title,
            priority: t.priority,
            status: t.status,
            triggerId: t.triggerId,
            createdAt: t.createdAt.toISOString(),
        })),
        total,
        counts: {
            high: highCount,
            medium: mediumCount,
            low: lowCount,
            total: highCount + mediumCount + lowCount,
        },
    }
}

export async function resolveTask(taskId: string, resolution: 'done' | 'skipped') {
    await prisma.managerTask.update({
        where: { id: taskId },
        data: {
            status: resolution,
            resolvedAt: new Date(),
            resolvedBy: 'manager', // in production, would use actual user
        },
    })
    revalidatePath('/inbox')
}

export async function getTaskCounts() {
    const [high, medium, low] = await Promise.all([
        prisma.managerTask.count({ where: { status: 'open', priority: 'high' } }),
        prisma.managerTask.count({ where: { status: 'open', priority: 'medium' } }),
        prisma.managerTask.count({ where: { status: 'open', priority: 'low' } }),
    ])
    return { high, medium, low, total: high + medium + low }
}
