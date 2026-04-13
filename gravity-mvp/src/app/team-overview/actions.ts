'use server'

import { prisma } from '@/lib/prisma'
import { logTaskEvent } from '@/lib/tasks/task-event-service'
import { isManagerOverloaded } from '@/lib/tasks/workload-config'
import { CONTACT_EVENT_TYPES, isLateResponse } from '@/lib/tasks/response-config'
import { isFastClose } from '@/lib/tasks/completion-config'
import { evaluateTaskRisk } from '@/lib/tasks/risk-config'
import { RESPONSE_THRESHOLDS } from '@/lib/tasks/response-config'
import { getRootCauseLabel } from '@/lib/tasks/root-cause-config'
import { PATTERN_THRESHOLDS } from '@/lib/tasks/pattern-config'
import { calculateManagerHealthScore, calculateHealthTrend, getPreviousHealthScores, saveHealthScores, updateDeclineStreak, isSustainedDecline, type HealthLevel, type HealthScoreBreakdown, type HealthTrend } from '@/lib/tasks/manager-health-config'
import { buildInterventionReasons, type InterventionReason } from '@/lib/tasks/intervention-config'
import { type InterventionAction } from '@/lib/tasks/intervention-action-config'

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
    lateResponses: number
    reopened: number
    fastClosed: number
    highRiskTasks: number
    escalated: number
    healthScore: number
    healthLevel: HealthLevel
    healthBreakdown: HealthScoreBreakdown
    healthTrend: HealthTrend
    previousHealthScore: number | null
    declineStreak: number
    sustainedDecline: boolean
    needsIntervention: boolean
    interventionPriority: InterventionPriority
    interventionReasons: InterventionReason[]
    lastInterventionAction: InterventionActionRecord | null
    nextTask: ManagerNextTask | null
}

export type InterventionPriority = 'urgent' | 'high' | 'normal'

export interface InterventionActionRecord {
    action: string
    comment: string | null
    timestamp: string
}

export interface RootCauseStat {
    cause: string
    label: string
    count: number
}

export type TrendDirection = 'up' | 'down' | 'stable'

export interface PatternAlert {
    rootCause: string
    label: string
    count: number
    windowHours: number
    level: 'warning' | 'pattern'
    trend: TrendDirection
    previousCount: number
}

export interface TeamOverview {
    totals: {
        active: number
        overdue: number
        highPriority: number
        closedToday: number
        lateResponses: number
        reopened: number
        fastClosed: number
        highRiskTasks: number
        escalated: number
        avgHealthScore: number
        criticalManagers: number
        improvingManagers: number
        decliningManagers: number
        sustainedDeclineManagers: number
        urgentIntervention: number
        highIntervention: number
    }
    topRootCauses: RootCauseStat[]
    patternAlerts: PatternAlert[]
    interventionQueue: ManagerStats[]
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
            totals: { active: 0, overdue: 0, highPriority: 0, closedToday: 0, lateResponses: 0, reopened: 0, fastClosed: 0, highRiskTasks: 0, escalated: 0, avgHealthScore: 100, criticalManagers: 0, improvingManagers: 0, decliningManagers: 0, sustainedDeclineManagers: 0, urgentIntervention: 0, highIntervention: 0 },
            topRootCauses: [],
            patternAlerts: [],
            interventionQueue: [],
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
            createdAt: true,
            metadata: true,
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

    // Batch: count late responses per manager
    // Find tasks assigned to these users that have a first contact event
    // and the response time exceeds the threshold
    const assignedTaskIds = activeTasks.map(t => t.id)
    const lateResponseMap = new Map<string, number>()
    let firstEventByTask = new Map<string, Date>()

    if (assignedTaskIds.length > 0) {
        // Get all tasks with their creation time and first contact event
        const tasksWithCreation = await prisma.task.findMany({
            where: {
                id: { in: assignedTaskIds },
            },
            select: { id: true, createdAt: true, assigneeId: true },
        })
        const taskCreatedMap = new Map(tasksWithCreation.map(t => [t.id, { createdAt: t.createdAt, assigneeId: t.assigneeId }]))

        // Get first contact event per task (oldest first)
        const firstContactEvents = await prisma.taskEvent.findMany({
            where: {
                taskId: { in: assignedTaskIds },
                eventType: { in: CONTACT_EVENT_TYPES },
            },
            orderBy: { createdAt: 'asc' },
            select: { taskId: true, createdAt: true },
        })

        // Dedupe: keep only first event per task
        firstEventByTask = new Map<string, Date>()
        for (const ev of firstContactEvents) {
            if (!firstEventByTask.has(ev.taskId)) {
                firstEventByTask.set(ev.taskId, ev.createdAt)
            }
        }

        // Calculate late responses per manager
        for (const [taskId, firstContactAt] of firstEventByTask) {
            const taskInfo = taskCreatedMap.get(taskId)
            if (!taskInfo || !taskInfo.assigneeId) continue
            const responseMinutes = (firstContactAt.getTime() - taskInfo.createdAt.getTime()) / 60000
            if (isLateResponse(responseMinutes)) {
                lateResponseMap.set(taskInfo.assigneeId, (lateResponseMap.get(taskInfo.assigneeId) || 0) + 1)
            }
        }
    }

    // Batch: reopened tasks (status_changed events from done/cancelled back to active statuses)
    const reopenedEvents = await prisma.taskEvent.findMany({
        where: {
            eventType: 'status_changed',
            taskId: { in: assignedTaskIds.length > 0 ? assignedTaskIds : ['__none__'] },
        },
        select: { taskId: true, payload: true },
    })
    const reopenedTaskIds = new Set<string>()
    for (const ev of reopenedEvents) {
        const p = ev.payload as any
        if (p && ['done', 'cancelled'].includes(p.from) && ['todo', 'in_progress', 'waiting_reply'].includes(p.to)) {
            reopenedTaskIds.add(ev.taskId)
        }
    }
    // Map reopened tasks to assignees
    const reopenedMap = new Map<string, number>()
    for (const taskId of reopenedTaskIds) {
        const t = activeTasks.find(at => at.id === taskId)
        if (t?.assigneeId) {
            reopenedMap.set(t.assigneeId, (reopenedMap.get(t.assigneeId) || 0) + 1)
        }
    }

    // Batch: fast-closed tasks (resolved today, time between created and resolved < threshold)
    const recentlyClosed = await prisma.task.findMany({
        where: {
            status: { in: ['done', 'cancelled'] },
            resolvedAt: { gte: todayStart, lte: todayEnd },
            assigneeId: { in: userIds },
        },
        select: { id: true, assigneeId: true, createdAt: true, resolvedAt: true },
    })
    const fastClosedMap = new Map<string, number>()
    for (const t of recentlyClosed) {
        if (t.resolvedAt && t.assigneeId && isFastClose(t.createdAt, t.resolvedAt)) {
            fastClosedMap.set(t.assigneeId, (fastClosedMap.get(t.assigneeId) || 0) + 1)
        }
    }

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
            lateResponses: lateResponseMap.get(user.id) || 0,
            reopened: reopenedMap.get(user.id) || 0,
            fastClosed: fastClosedMap.get(user.id) || 0,
            highRiskTasks: tasks.filter(t => {
                const meta = (t.metadata as Record<string, any>) || {}
                const attempts = meta.attempts || 0
                const isReopened = reopenedTaskIds.has(t.id)
                const hasContact = firstEventByTask.has(t.id)
                return evaluateTaskRisk({
                    attempts,
                    isReopened,
                    hasContact,
                    createdAt: t.createdAt,
                    slaDeadline: t.slaDeadline,
                    responseThresholdMinutes: RESPONSE_THRESHOLDS.maxResponseMinutes,
                }) === 'high'
            }).length,
            escalated: tasks.filter(t => {
                const meta = (t.metadata as Record<string, any>) || {}
                return !!meta.escalated
            }).length,
            // Health score computed below after all metrics are set
            healthScore: 0,
            healthLevel: 'healthy' as HealthLevel,
            healthBreakdown: { overdue: 0, escalated: 0, lateResponses: 0, reopened: 0, fastClosed: 0, highRisk: 0, overload: 0 },
            healthTrend: 'stable' as HealthTrend,
            previousHealthScore: null,
            declineStreak: 0,
            sustainedDecline: false,
            needsIntervention: false,
            interventionPriority: 'normal' as InterventionPriority,
            interventionReasons: [] as InterventionReason[],
            lastInterventionAction: null,
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

    // Compute health scores + trends + decline streaks
    const previousData = await getPreviousHealthScores()
    for (const m of managers) {
        const health = calculateManagerHealthScore({
            overdue: m.overdue,
            escalated: m.escalated,
            lateResponses: m.lateResponses,
            reopened: m.reopened,
            fastClosed: m.fastClosed,
            highRiskTasks: m.highRiskTasks,
            isOverloaded: m.isOverloaded,
        })
        m.healthScore = health.score
        m.healthLevel = health.level
        m.healthBreakdown = health.breakdown

        const prev = previousData.get(m.managerId) ?? null
        m.healthTrend = calculateHealthTrend(health.score, prev?.score ?? null)
        m.previousHealthScore = prev?.score ?? null
        m.declineStreak = updateDeclineStreak(m.healthTrend, prev?.declineStreak ?? 0)
        m.sustainedDecline = isSustainedDecline(m.declineStreak)
    }
    // Persist current scores and decline streaks for next comparison
    await saveHealthScores(managers.map(m => ({ managerId: m.managerId, score: m.healthScore, declineStreak: m.declineStreak })))

    // Compute intervention priority + reasons
    for (const m of managers) {
        const isUrgent = m.healthLevel === 'critical'
            || m.sustainedDecline
            || (m.escalated > 0 && m.overdue > 0)
        const isHigh = m.healthLevel === 'warning'
            || m.healthTrend === 'declining'
            || m.highRiskTasks > 0

        if (isUrgent) {
            m.interventionPriority = 'urgent'
            m.needsIntervention = true
        } else if (isHigh) {
            m.interventionPriority = 'high'
            m.needsIntervention = true
        } else {
            m.interventionPriority = 'normal'
            m.needsIntervention = false
        }

        m.interventionReasons = m.needsIntervention
            ? buildInterventionReasons({
                healthLevel: m.healthLevel,
                sustainedDecline: m.sustainedDecline,
                escalated: m.escalated,
                overdue: m.overdue,
                healthTrend: m.healthTrend,
                highRiskTasks: m.highRiskTasks,
            })
            : []
    }

    // Load last intervention actions for all managers
    const lastActions = await getLastInterventionActions()
    for (const m of managers) {
        const la = lastActions.get(m.managerId)
        m.lastInterventionAction = la ?? null
    }

    // Build intervention queue (urgent + high only, sorted)
    const priorityOrder: Record<InterventionPriority, number> = { urgent: 0, high: 1, normal: 2 }
    const interventionQueue = managers
        .filter(m => m.needsIntervention)
        .sort((a, b) =>
            priorityOrder[a.interventionPriority] - priorityOrder[b.interventionPriority]
            || b.overdue - a.overdue
            || b.escalated - a.escalated
            || a.healthScore - b.healthScore
        )

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
        lateResponses: managers.reduce((s, m) => s + m.lateResponses, 0),
        reopened: managers.reduce((s, m) => s + m.reopened, 0),
        fastClosed: managers.reduce((s, m) => s + m.fastClosed, 0),
        highRiskTasks: managers.reduce((s, m) => s + m.highRiskTasks, 0),
        escalated: managers.reduce((s, m) => s + m.escalated, 0),
        avgHealthScore: managers.length > 0 ? Math.round(managers.reduce((s, m) => s + m.healthScore, 0) / managers.length) : 100,
        criticalManagers: managers.filter(m => m.healthLevel === 'critical').length,
        improvingManagers: managers.filter(m => m.healthTrend === 'improving').length,
        decliningManagers: managers.filter(m => m.healthTrend === 'declining').length,
        sustainedDeclineManagers: managers.filter(m => m.sustainedDecline).length,
        urgentIntervention: managers.filter(m => m.interventionPriority === 'urgent').length,
        highIntervention: managers.filter(m => m.interventionPriority === 'high').length,
    }

    // Top root causes today (from escalation_resolved events)
    const rootCauseEvents = await prisma.taskEvent.findMany({
        where: {
            eventType: 'escalation_resolved',
            createdAt: { gte: todayStart, lte: todayEnd },
        },
        select: { payload: true },
    })
    const rootCauseCounts = new Map<string, number>()
    for (const ev of rootCauseEvents) {
        const rc = (ev.payload as any)?.rootCause
        if (rc) {
            rootCauseCounts.set(rc, (rootCauseCounts.get(rc) || 0) + 1)
        }
    }
    const topRootCauses: RootCauseStat[] = Array.from(rootCauseCounts.entries())
        .map(([cause, count]) => ({ cause, label: getRootCauseLabel(cause), count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3)

    // Pattern alerts with trend: detect repeating root causes in recent window
    const patternWindowMs = PATTERN_THRESHOLDS.patternWindowHours * 60 * 60 * 1000
    const trendWindowMs = PATTERN_THRESHOLDS.trendWindowHours * 60 * 60 * 1000
    const patternWindowStart = new Date(now.getTime() - patternWindowMs)
    const previousWindowStart = new Date(now.getTime() - patternWindowMs - trendWindowMs)

    // Get events from both current and previous windows in one query
    const allResolvedEvents = await prisma.taskEvent.findMany({
        where: {
            eventType: 'escalation_resolved',
            createdAt: { gte: previousWindowStart },
        },
        select: { payload: true, createdAt: true },
    })

    const patternCounts = new Map<string, number>()
    const previousCounts = new Map<string, number>()
    for (const ev of allResolvedEvents) {
        const rc = (ev.payload as any)?.rootCause
        if (!rc) continue
        if (ev.createdAt >= patternWindowStart) {
            patternCounts.set(rc, (patternCounts.get(rc) || 0) + 1)
        } else {
            previousCounts.set(rc, (previousCounts.get(rc) || 0) + 1)
        }
    }

    const patternAlerts: PatternAlert[] = Array.from(patternCounts.entries())
        .filter(([, count]) => count >= PATTERN_THRESHOLDS.warningThreshold)
        .map(([rootCause, count]) => {
            const prev = previousCounts.get(rootCause) || 0
            let trend: TrendDirection = 'stable'
            if (count > prev) trend = 'up'
            else if (count < prev) trend = 'down'

            return {
                rootCause,
                label: getRootCauseLabel(rootCause),
                count,
                windowHours: PATTERN_THRESHOLDS.patternWindowHours,
                level: (count >= PATTERN_THRESHOLDS.patternThreshold ? 'pattern' : 'warning') as 'warning' | 'pattern',
                trend,
                previousCount: prev,
            }
        })
        .sort((a, b) => b.count - a.count)

    return { totals, topRootCauses, patternAlerts, interventionQueue, managers }
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

// ─── Intervention Actions (raw SQL, no migrations) ──────────

const ENSURE_INTERVENTION_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS intervention_actions (
  id TEXT PRIMARY KEY,
  manager_id TEXT NOT NULL,
  action TEXT NOT NULL,
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_INTERVENTION_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_intervention_actions_manager
ON intervention_actions (manager_id, created_at DESC)`

let interventionTableEnsured = false

async function ensureInterventionTable() {
    if (interventionTableEnsured) return
    await prisma.$executeRawUnsafe(ENSURE_INTERVENTION_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_INTERVENTION_INDEX_SQL)
    interventionTableEnsured = true
}

/**
 * Log an intervention action for a manager.
 */
export async function logInterventionAction(params: {
    managerId: string
    action: InterventionAction
    comment?: string
}): Promise<void> {
    await ensureInterventionTable()
    const id = `ia_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const comment = params.comment?.trim() || null
    await prisma.$executeRawUnsafe(
        `INSERT INTO intervention_actions (id, manager_id, action, comment, created_at)
         VALUES ($1, $2, $3, $4, NOW())`,
        id, params.managerId, params.action, comment
    )
}

/**
 * Get the last intervention action for each manager.
 */
async function getLastInterventionActions(): Promise<Map<string, InterventionActionRecord>> {
    await ensureInterventionTable()
    const rows: { manager_id: string; action: string; comment: string | null; created_at: Date }[] =
        await prisma.$queryRawUnsafe(`
            SELECT DISTINCT ON (manager_id) manager_id, action, comment, created_at
            FROM intervention_actions
            ORDER BY manager_id, created_at DESC
        `)
    const map = new Map<string, InterventionActionRecord>()
    for (const r of rows) {
        map.set(r.manager_id, {
            action: r.action,
            comment: r.comment,
            timestamp: r.created_at.toISOString(),
        })
    }
    return map
}
