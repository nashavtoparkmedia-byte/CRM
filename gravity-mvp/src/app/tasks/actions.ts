'use server'

import { prisma } from '@/lib/prisma'
import { logTaskEvent } from '@/lib/tasks/task-event-service'
import type {
    TaskDTO,
    TaskDetailDTO,
    TaskEventDTO,
    CreateTaskInput,
    UpdateTaskInput,
    TaskFilters,
    SimilarTaskHint,
} from '@/lib/tasks/types'
import type { Prisma, Task } from '@prisma/client'
import { getScenario, getStage, calculateSlaDeadline, getMainScenarioIds } from '@/lib/tasks/scenario-config'

// ─── Helpers ───────────────────────────────────────────────────────────────

type TaskWithDriver = Task & {
    driver: { fullName: string; phone: string | null; segment: string; lastOrderAt: Date | null }
}

function toTaskDTO(t: TaskWithDriver): TaskDTO {
    return {
        id: t.id,
        driverId: t.driverId,
        driverName: t.driver.fullName,
        driverPhone: t.driver.phone,
        driverSegment: t.driver.segment,
        driverLastOrderAt: t.driver.lastOrderAt ? t.driver.lastOrderAt.toISOString() : null,
        source: t.source,
        type: t.type,
        title: t.title,
        description: t.description,
        status: t.status,
        priority: t.priority,
        isActive: t.isActive,
        triggerType: t.triggerType,
        triggerKey: t.triggerKey,
        dedupeKey: t.dedupeKey,
        dueAt: t.dueAt?.toISOString() ?? null,
        assigneeId: t.assigneeId,
        createdBy: t.createdBy,
        chatId: t.chatId,
        originMessageId: t.originMessageId,
        originExcerpt: t.originExcerpt,
        hasNewReply: t.hasNewReply,
        lastInboundMessageAt: t.lastInboundMessageAt?.toISOString() ?? null,
        lastOutboundMessageAt: t.lastOutboundMessageAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        resolvedAt: t.resolvedAt?.toISOString() ?? null,
        
        // Scenario (Phase 1 — from DB columns)
        scenario: t.scenario ?? null,
        stage: t.stage ?? null,
        stageEnteredAt: t.stageEnteredAt?.toISOString() ?? null,
        nextActionAt: t.nextActionAt?.toISOString() ?? null,
        slaDeadline: t.slaDeadline?.toISOString() ?? null,
        closedReason: t.closedReason ?? null,
        closedComment: t.closedComment ?? null,

        // Legacy metadata
        attempts: (t.metadata as any)?.attempts || 0,
        nextActionId: (t.metadata as any)?.nextActionId,
    }
}

function buildWhere(filters: TaskFilters): Prisma.TaskWhereInput {
    const where: Prisma.TaskWhereInput = {}

    if (filters.isActive !== undefined) {
        where.isActive = filters.isActive
    }
    if (filters.status && filters.status !== 'all') {
        where.status = filters.status
    }
    if (filters.priority && filters.priority !== 'all') {
        where.priority = filters.priority
    }
    if (filters.source && filters.source !== 'all') {
        where.source = filters.source
    }
    if (filters.assigneeId) {
        where.assigneeId = filters.assigneeId
    }
    if (filters.driverId) {
        where.driverId = filters.driverId
    }
    if (filters.hasNewReply !== undefined) {
        where.hasNewReply = filters.hasNewReply
    }
    if (filters.search) {
        where.OR = [
            { title: { contains: filters.search, mode: 'insensitive' } },
            { driver: { fullName: { contains: filters.search, mode: 'insensitive' } } },
        ]
    }

    // Scenario filters
    if (filters.scenario !== undefined) {
        where.scenario = filters.scenario // null = "без сценария"
    }
    if (filters.stage) {
        where.stage = filters.stage
    }

    // Extended filters
    if (filters.type) {
        where.type = filters.type
    }
    if (filters.dateFrom || filters.dateTo) {
        where.createdAt = {}
        if (filters.dateFrom) (where.createdAt as any).gte = new Date(filters.dateFrom)
        if (filters.dateTo) (where.createdAt as any).lte = new Date(filters.dateTo)
    }

    return where
}

// ─── CRM Users ──────────────────────────────────────────────────────────────

export async function getCrmUsers() {
    const users = await prisma.crmUser.findMany({
        where: { isActive: true },
        orderBy: { name: 'asc' },
        select: { id: true, name: true, role: true },
    })
    return users
}

// ─── Search Helpers ──────────────────────────────────────────────────────────

export async function searchDriversForTask(query: string) {
    if (!query || query.length < 2) return []
    const drivers = await prisma.driver.findMany({
        where: {
            OR: [
                { fullName: { contains: query, mode: 'insensitive' } },
                { phone: { contains: query } }
            ]
        },
        take: 10,
        select: {
            id: true,
            fullName: true,
            phone: true
        }
    })
    return drivers
}

// ─── CRUD Actions ──────────────────────────────────────────────────────────

/**
 * Fetch tasks for the active working scope.
 * Returns a flat list — the store handles normalization.
 */
export async function getTasks(
    filters: TaskFilters = {},
    sort: { field: string; direction: 'asc' | 'desc' } = { field: 'createdAt', direction: 'desc' }
): Promise<{ tasks: TaskDTO[]; total: number }> {
    const nowTime = new Date();
    const itemsToOverdue = await prisma.task.findMany({
        where: { isActive: true, dueAt: { lt: nowTime }, status: { in: ['todo', 'in_progress', 'waiting_reply'] } },
        select: { id: true, status: true }
    });
    
    if (itemsToOverdue.length > 0) {
        await prisma.task.updateMany({
            where: { id: { in: itemsToOverdue.map(t => t.id) } },
            data: { status: 'overdue' }
        });
        const { logTaskEvent } = await import('@/lib/tasks/task-event-service');
        for (const t of itemsToOverdue) {
            await logTaskEvent(t.id, 'status_changed', { from: t.status, to: 'overdue' }, { type: 'system' });
        }
    }
    await recalculateAllTaskAttempts();

    const where = buildWhere(filters)

    const orderBy: Prisma.TaskOrderByWithRelationInput = {}
    if (sort.field === 'priority') {
        orderBy.priority = sort.direction
    } else if (sort.field === 'dueAt') {
        orderBy.dueAt = sort.direction
    } else if (sort.field === 'updatedAt') {
        orderBy.updatedAt = sort.direction
    } else {
        orderBy.createdAt = sort.direction
    }

    const [tasks, total] = await Promise.all([
        prisma.task.findMany({
            where,
            orderBy,
            take: 200, // safety cap — active scope should be ~100
            include: {
                driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
            },
        }),
        prisma.task.count({ where }),
    ])

    return {
        tasks: tasks.map(toTaskDTO),
        total,
    }
}

/**
 * Get a single task by ID.
 */
export async function getTaskById(id: string): Promise<TaskDTO | null> {
    const task = await prisma.task.findUnique({
        where: { id },
        include: {
            driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
        },
    })
    return task ? toTaskDTO(task) : null
}

/**
 * Get task details with event history (on-demand for TaskDetailsPane).
 */
export async function getTaskDetails(id: string): Promise<TaskDetailDTO | null> {
    const task = await prisma.task.findUnique({
        where: { id },
        include: {
            driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
            events: {
                orderBy: { createdAt: 'desc' },
                take: 50,
            },
        },
    })

    if (!task) return null

    const events: TaskEventDTO[] = task.events.map((e) => ({
        id: e.id,
        taskId: e.taskId,
        eventType: e.eventType,
        payload: (e.payload as Record<string, unknown>) ?? {},
        actorType: e.actorType,
        actorId: e.actorId,
        createdAt: e.createdAt.toISOString(),
    }))

    return {
        ...toTaskDTO(task),
        events,
    }
}

/**
 * Create a new task.
 */
export async function createTask(input: CreateTaskInput): Promise<TaskDTO> {
    const { cookies } = await import('next/headers');
    const cookieStore = await cookies();
    const currentUserId = cookieStore.get('crm_user_id')?.value || null;

    // Enforce single main scenario per driver
    if (input.scenario) {
        const scenarioConfig = getScenario(input.scenario)
        if (scenarioConfig?.isMainScenario) {
            const mainIds = getMainScenarioIds()
            const existing = await prisma.task.findFirst({
                where: {
                    driverId: input.driverId,
                    scenario: { in: mainIds },
                    isActive: true,
                },
                select: { id: true, scenario: true },
            })
            if (existing) {
                const existingLabel = getScenario(existing.scenario!)?.label ?? existing.scenario
                throw new Error(`У водителя уже есть активный сценарий: ${existingLabel}`)
            }
        }
    }

    const task = await prisma.task.create({
        data: {
            driverId: input.driverId,
            source: input.source,
            type: input.type,
            title: input.title,
            description: input.description,
            priority: input.priority ?? 'medium',
            dueAt: input.dueAt ? new Date(input.dueAt) : null,
            assigneeId: input.assigneeId || currentUserId,
            createdBy: 'manager', // TODO: real user

            // Chat context
            chatId: input.chatId,
            originMessageId: input.originMessageId,
            originExcerpt: input.originExcerpt,
            originCreatedAt: input.originCreatedAt ? new Date(input.originCreatedAt) : null,

            // Auto-task fields
            triggerType: input.triggerType,
            triggerKey: input.triggerKey,
            dedupeKey: input.dedupeKey,

            // Scenario
            scenario: input.scenario ?? null,
            stage: input.stage ?? null,
            stageEnteredAt: input.stage ? new Date() : null,
            slaDeadline: (input.scenario && input.stage)
                ? calculateSlaDeadline(input.scenario, input.stage, new Date())
                : null,
        },
        include: {
            driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
        },
    })

    // Auto-populate contactId if not set
    if (!task.contactId) {
        try {
            const driver = await prisma.driver.findUnique({
                where: { id: input.driverId },
                select: { yandexDriverId: true },
            })
            if (driver?.yandexDriverId) {
                const contact = await prisma.contact.findUnique({
                    where: { yandexDriverId: driver.yandexDriverId },
                    select: { id: true },
                })
                if (contact) {
                    await prisma.task.update({
                        where: { id: task.id },
                        data: { contactId: contact.id },
                    })
                }
            }
        } catch {
            // Non-critical: contactId is nullable
        }
    }

    await logTaskEvent(task.id, 'created', {
        source: input.source,
        type: input.type,
        chatId: input.chatId ?? null,
        scenario: input.scenario ?? null,
        stage: input.stage ?? null,
    }, { type: input.source === 'auto' ? 'auto' : 'user' })

    return toTaskDTO(task)
}

/**
 * Change the stage of a scenario task.
 * Validates that the stage exists in the scenario config.
 */
export async function changeStage(taskId: string, newStage: string): Promise<TaskDTO> {
    const task = await prisma.task.findUniqueOrThrow({ where: { id: taskId } })
    if (!task.scenario) {
        throw new Error('Cannot change stage: task has no scenario')
    }
    const stageConfig = getStage(task.scenario, newStage)
    if (!stageConfig) {
        throw new Error(`Unknown stage "${newStage}" for scenario "${task.scenario}"`)
    }
    return updateTask(taskId, { stage: newStage })
}

/**
 * Update a task (partial patch).
 */
export async function updateTask(id: string, patch: UpdateTaskInput): Promise<TaskDTO> {
    const prevTask = await prisma.task.findUniqueOrThrow({ where: { id } })

    // Allow setting dueAt in the past to trigger overdue status
    const data: Prisma.TaskUpdateInput = {}
    if (patch.title !== undefined) data.title = patch.title
    if (patch.description !== undefined) data.description = patch.description
    if (patch.priority !== undefined) data.priority = patch.priority
    if (patch.type !== undefined) data.type = patch.type
    if (patch.dueAt !== undefined) data.dueAt = patch.dueAt ? new Date(patch.dueAt) : null
    if (patch.assigneeId !== undefined) data.assigneeId = patch.assigneeId
    if (patch.hasNewReply !== undefined) data.hasNewReply = patch.hasNewReply
    if (patch.isActive !== undefined) data.isActive = patch.isActive
    if (patch.source !== undefined) data.source = patch.source as any

    // Scenario field updates (Phase 1 — DB columns)
    if (patch.stage !== undefined && patch.stage !== prevTask.stage && prevTask.scenario) {
        const stageConfig = getStage(prevTask.scenario, patch.stage)
        if (!stageConfig) {
            throw new Error(`Unknown stage "${patch.stage}" for scenario "${prevTask.scenario}"`)
        }
        const now = new Date()
        data.stage = patch.stage
        data.stageEnteredAt = now
        data.slaDeadline = calculateSlaDeadline(prevTask.scenario, patch.stage, now)
        await logTaskEvent(id, 'stage_changed', {
            from: prevTask.stage,
            to: patch.stage,
            scenarioId: prevTask.scenario,
        }, { type: 'user' })
    }
    if (patch.nextActionAt !== undefined) {
        data.nextActionAt = patch.nextActionAt ? new Date(patch.nextActionAt) : null
    }
    if (patch.slaDeadline !== undefined && patch.stage === undefined) {
        data.slaDeadline = patch.slaDeadline ? new Date(patch.slaDeadline) : null
    }
    if (patch.closedReason !== undefined) data.closedReason = patch.closedReason
    if (patch.closedComment !== undefined) data.closedComment = patch.closedComment

    // Legacy metadata updates (attempts, nextActionId)
    const meta = (prevTask.metadata as Record<string, any>) || {}
    const newMeta = { ...meta }
    let metaChanged = false

    if (patch.attempts !== undefined) {
        newMeta.attempts = patch.attempts
        metaChanged = true
    }
    if (patch.nextActionId !== undefined) {
        newMeta.nextActionId = patch.nextActionId
        metaChanged = true
    }

    if (patch.dueAt !== undefined) {
        const prevDue = prevTask.dueAt ? prevTask.dueAt.toISOString() : null
        const nextDue = patch.dueAt ? new Date(patch.dueAt).toISOString() : null
        // Compare truncated to minute to avoid false events from ms/sec drift
        const truncMin = (iso: string | null) => iso ? iso.slice(0, 16) : null
        if (prevDue !== nextDue && truncMin(prevDue) !== truncMin(nextDue) && nextDue !== null) {
            // REMOVED: do not count deadline shift as attempt
            await logTaskEvent(id, 'postponed', { from: prevDue, to: nextDue }, { type: 'user' })
        }
    }

    if (metaChanged) {
        data.metadata = newMeta
    }

    if (patch.status !== undefined) {
        data.status = patch.status
        // Mark inactive on terminal states
        if (['done', 'cancelled', 'archived'].includes(patch.status)) {
            // Scenario tasks require closedReason
            if (prevTask.scenario && !patch.closedReason && !prevTask.closedReason) {
                throw new Error('closedReason is required when closing a scenario task')
            }
            data.isActive = false
            data.resolvedAt = new Date()
            data.resolvedBy = 'manager'
        }
        // Reopen logic
        if (['todo', 'in_progress', 'waiting_reply'].includes(patch.status) && !prevTask.isActive) {
            data.isActive = true
            data.resolvedAt = null
            data.resolvedBy = null
        }
    }

    // --- Automatic Status Sync ---
    let finalStatus = (data.status as string) || (prevTask.status as string)
    let autoStatusChanged = false
    const isTerminal = ['done', 'cancelled', 'archived'].includes(finalStatus)

    if (patch.dueAt !== undefined && !isTerminal) {
        const nextDue = patch.dueAt ? new Date(patch.dueAt) : null
        const now = new Date()

        if (nextDue) {
            if (nextDue > now && finalStatus === 'overdue') {
                finalStatus = 'in_progress'
                data.status = 'in_progress'
                data.isActive = true
                autoStatusChanged = true
            } else if (nextDue < now && finalStatus !== 'overdue') {
                finalStatus = 'overdue'
                data.status = 'overdue'
                data.isActive = true
                autoStatusChanged = true
            }
        }
    }

    if (Object.keys(data).length === 0) {
         const t = await prisma.task.findUniqueOrThrow({ where: { id }, include: { driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } } } });
         return toTaskDTO(t);
    }

    const task = await prisma.task.update({
        where: { id },
        data,
        include: {
            driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
        },
    })

    // Log status change
    if (finalStatus !== prevTask.status) {
        const actorType = (autoStatusChanged && !patch.status) ? 'system' : 'user'
        const statusPayload: Record<string, unknown> = {
            from: prevTask.status,
            to: finalStatus,
        }
        // Enrich close events with reason/comment for history display
        if (finalStatus === 'done' || finalStatus === 'cancelled') {
            const reason = patch.closedReason || prevTask.closedReason
            const comment = patch.closedComment || prevTask.closedComment
            if (reason) statusPayload.closedReason = reason
            if (comment) statusPayload.closedComment = comment
        }
        await logTaskEvent(task.id, 'status_changed', statusPayload, { type: actorType })
    }

    return toTaskDTO(task)
}

/**
 * Quick resolve: done/cancelled/skipped.
 */
export async function resolveTask(id: string, resolution: 'done' | 'cancelled'): Promise<TaskDTO> {
    return updateTask(id, { status: resolution })
}

// ─── Driver Tasks (for Chat Widget) ───────────────────────────────────────

/**
 * Get active tasks for a specific driver (compact, for chat sidebar widget).
 */
export async function getDriverActiveTasks(driverId: string): Promise<{
    tasks: TaskDTO[]
    counts: { active: number; overdue: number }
}> {
    const now = new Date()

    const [tasks, overdueCount] = await Promise.all([
        prisma.task.findMany({
            where: { driverId, isActive: true },
            orderBy: [{ priority: 'asc' }, { dueAt: 'asc' }],
            take: 5,
            include: {
                driver: { select: { fullName: true, phone: true, segment: true, lastOrderAt: true } },
            },
        }),
        prisma.task.count({
            where: { driverId, isActive: true, dueAt: { lt: now } },
        }),
    ])

    const activeCount = await prisma.task.count({
        where: { driverId, isActive: true },
    })

    return {
        tasks: tasks.map(toTaskDTO),
        counts: { active: activeCount, overdue: overdueCount },
    }
}

// ─── Soft Dedupe Check ─────────────────────────────────────────────────────

/**
 * Check for similar active tasks before creating a new manual/chat task.
 */
export async function checkSimilarTasks(
    driverId: string,
    type: string,
    dueAt?: string
): Promise<SimilarTaskHint[]> {
    const where: Prisma.TaskWhereInput = {
        driverId,
        type,
        isActive: true,
    }

    const similar = await prisma.task.findMany({
        where,
        select: {
            id: true,
            title: true,
            status: true,
            dueAt: true,
            createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
    })

    return similar.map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        dueAt: t.dueAt?.toISOString() ?? null,
        createdAt: t.createdAt.toISOString(),
    }))
}

// ─── Counts (for navigation badge) ────────────────────────────────────────

export async function getActiveTaskCounts() {
    const [total, overdue, withReply] = await Promise.all([
        prisma.task.count({ where: { isActive: true } }),
        prisma.task.count({ where: { isActive: true, dueAt: { lt: new Date() } } }),
        prisma.task.count({ where: { isActive: true, hasNewReply: true } }),
    ])
    return { total, overdue, withReply }
}

export async function addTaskAction(id: string, actionType: string, resultId?: string, comment?: string): Promise<void> {
    const task = await prisma.task.findUniqueOrThrow({ where: { id } });
    const meta = (task.metadata as Record<string, any>) || {};
    
    // Increment attempts ONLY for communication actions
    const communicationActions = ['called', 'wrote', 'message_sent', 'contacted'];
    if (communicationActions.includes(actionType)) {
        meta.attempts = (meta.attempts || 0) + 1;
        await prisma.task.update({
            where: { id },
            data: { metadata: meta }
        });
    }

    await logTaskEvent(id, actionType, { resultId, comment }, { type: 'user' })
}

export async function correctTaskAction(
    id: string, 
    originalEventId: string, 
    newResultId: string, 
    newComment?: string
): Promise<void> {
    const originalEvent = await prisma.taskEvent.findUniqueOrThrow({ 
        where: { id: originalEventId } 
    });
    
    const payload = originalEvent.payload as any;
    
    await logTaskEvent(id, 'contact_corrected', { 
        originalEventId, 
        oldResultId: payload?.newResultId || payload?.resultId, 
        newResultId, 
        comment: newComment 
    }, { type: 'user' });
}

/**
 * Migration: Recalculate attempts for all tasks based on historical events
 */
export async function recalculateAllTaskAttempts(): Promise<{ updated: number }> {
    const communicationActions = ['called', 'wrote', 'message_sent', 'contacted'];
    const tasks = await prisma.task.findMany({
        include: {
            events: {
                where: {
                    eventType: { in: communicationActions }
                }
            }
        }
    });

    let updated = 0;
    for (const task of tasks) {
        const count = task.events.length;
        const meta = (task.metadata as Record<string, any>) || {};
        
        if (meta.attempts !== count) {
            meta.attempts = count;
            await prisma.task.update({
                where: { id: task.id },
                data: { metadata: meta }
            });
            updated++;
        }
    }

    return { updated };
}
