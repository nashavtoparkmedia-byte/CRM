// Trigger evaluation engine — checks conditions and executes actions

import { prisma } from '@/lib/prisma'
import { logCommunicationEvent } from './communications'
import { sendTelegramMessage } from '@/app/tg-actions'
import { createTask } from '@/app/tasks/actions'
import { getScenario } from '@/lib/tasks/scenario-config'
import { evaluateTaskRisk } from '@/lib/tasks/risk-config'
import { CONTACT_EVENT_TYPES, RESPONSE_THRESHOLDS } from '@/lib/tasks/response-config'
import { FOLLOWUP_THRESHOLDS } from '@/lib/tasks/followup-config'
import { ESCALATION_THRESHOLDS } from '@/lib/tasks/escalation-config'

interface DriverState {
    id: string
    fullName: string
    phone: string | null
    segment: string
    daysWithoutTrips: number
    hadRecentPromotion: boolean
}

/**
 * Evaluate all active triggers for all drivers (called from nightly sync)
 */
export async function evaluateAllTriggers(): Promise<{ tasksCreated: number; messagesSent: number }> {
    const triggers = await prisma.communicationTrigger.findMany({
        where: { isActive: true },
    })

    if (triggers.length === 0) return { tasksCreated: 0, messagesSent: 0 }

    // Get all drivers with their recent summary data
    const drivers = await prisma.driver.findMany({
        select: {
            id: true,
            fullName: true,
            phone: true,
            segment: true,
        },
    })

    let tasksCreated = 0
    let messagesSent = 0

    for (const driver of drivers) {
        const state = await getDriverState(driver)

        for (const trigger of triggers) {
            const shouldFire = evaluateCondition(trigger.condition, trigger.threshold, state)

            if (shouldFire) {
                // Check if already fired today for this driver+trigger combo
                const today = new Date()
                today.setHours(0, 0, 0, 0)
                const tomorrow = new Date(today)
                tomorrow.setDate(tomorrow.getDate() + 1)

                const alreadyFired = await prisma.communicationEvent.findFirst({
                    where: {
                        driverId: driver.id,
                        eventType: 'trigger_fired',
                        metadata: { path: ['triggerId'], equals: trigger.id },
                        createdAt: { gte: today, lt: tomorrow },
                    },
                })

                if (alreadyFired) continue

                // Execute the trigger action
                if (trigger.action === 'auto_message') {
                    const sent = await executeAutoMessage(trigger, state)
                    if (sent) messagesSent++
                } else if (trigger.action === 'manager_task') {
                    const created = await createScenarioTask(trigger, state)
                    if (created) tasksCreated++
                }

                // Log the trigger firing
                await logCommunicationEvent(
                    driver.id,
                    'system',
                    'system',
                    'trigger_fired',
                    `Триггер: ${trigger.name}`,
                    { triggerId: trigger.id, triggerName: trigger.name },
                    'system'
                )
            }
        }
    }

    return { tasksCreated, messagesSent }
}

/**
 * Get current state for a driver (for trigger evaluation)
 */
async function getDriverState(driver: { id: string; fullName: string; phone: string | null; segment: string }): Promise<DriverState> {
    // Count consecutive days without trips
    const summaries = await prisma.driverDaySummary.findMany({
        where: { driverId: driver.id },
        orderBy: { date: 'desc' },
        take: 30,
        select: { tripCount: true, hadPromotion: true },
    })

    let daysWithoutTrips = 0
    for (const s of summaries) {
        if (s.tripCount > 0) break
        daysWithoutTrips++
    }

    const hadRecentPromotion = summaries.slice(0, 7).some(s => s.hadPromotion)

    return {
        ...driver,
        daysWithoutTrips,
        hadRecentPromotion,
    }
}

/**
 * Check if a trigger condition is met
 */
function evaluateCondition(condition: string, threshold: number, state: DriverState): boolean {
    switch (condition) {
        case 'days_without_trips':
            return state.daysWithoutTrips >= threshold

        case 'segment_sleeping':
            return state.segment === 'sleeping'

        case 'segment_risk':
            return state.daysWithoutTrips >= threshold && state.segment !== 'sleeping'

        case 'after_promotion':
            return state.hadRecentPromotion && state.daysWithoutTrips >= threshold

        default:
            return false
    }
}

/**
 * Send auto-message via the configured channel
 */
async function executeAutoMessage(
    trigger: { id: string; messageTemplate: string | null; channel: string; name: string },
    state: DriverState
): Promise<boolean> {
    if (!state.phone || !trigger.messageTemplate) return false

    // Replace placeholders
    const message = trigger.messageTemplate
        .replace(/{name}/g, state.fullName.split(' ')[0])
        .replace(/{days}/g, String(state.daysWithoutTrips))
        .replace(/{segment}/g, state.segment)

    try {
        if (trigger.channel === 'telegram') {
            await sendTelegramMessage(state.phone, message)
        }
        // WhatsApp would go here in the future

        // Log the sent message
        await logCommunicationEvent(
            state.id,
            trigger.channel,
            'outbound',
            'auto_message',
            message,
            { triggerId: trigger.id, triggerName: trigger.name },
            'system'
        )

        return true
    } catch (err: any) {
        console.error(`[triggers] Failed to send auto-message to ${state.fullName}:`, err.message)
        return false
    }
}

/**
 * Create a scenario Task from a trigger (Phase 1 — replaces createManagerTask for new tasks).
 * Maps trigger conditions to scenarios. Deduplicates by scenario + driverId.
 */
async function createScenarioTask(
    trigger: { id: string; name: string; condition: string },
    state: DriverState
): Promise<boolean> {
    const scenario = mapTriggerToScenario(trigger.condition)
    const scenarioConfig = getScenario(scenario)
    if (!scenarioConfig) return false

    // Dedupe: check existing active Task with same scenario for this driver
    const existing = await prisma.task.findFirst({
        where: {
            driverId: state.id,
            scenario,
            isActive: true,
        },
    })
    if (existing) return false

    const priority = state.daysWithoutTrips >= 7 ? 'high' : 'medium'
    const title = `${scenarioConfig.label} — ${state.fullName} (${state.daysWithoutTrips}д без поездок)`

    try {
        await createTask({
            driverId: state.id,
            source: 'auto',
            type: scenario,
            title,
            priority: priority as any,
            scenario,
            stage: scenarioConfig.initialStage,
            triggerType: trigger.condition,
            triggerKey: `${trigger.condition}_${state.daysWithoutTrips}d`,
        })
        return true
    } catch (err) {
        // Scenario constraint error (e.g. already has active main scenario) — skip silently
        console.warn(`[triggers] Could not create scenario task for driver ${state.id}:`, (err as Error).message)
        return false
    }
}

// ─── Auto-Close: Churn & Onboarding ────────────────────────────────

const AUTO_CLOSE_REASONS: Record<string, string> = {
    churn: 'returned',       // Водитель вернулся — поездки появились
    onboarding: 'launched',  // Водитель вышел на линию — первая поездка зафиксирована
}

/**
 * Auto-close churn/onboarding tasks when trip activity is detected.
 * Called alongside evaluateAllTriggers() from nightly cron.
 *
 * Detection logic:
 *   Driver.lastOrderAt (DateTime?) — последний заказ.
 *   Если lastOrderAt > task.createdAt → водитель совершил поездку после создания задачи → закрываем.
 *
 * Не использует updateTask / logTaskEvent (они зависят от cookies).
 * Пишет напрямую в Prisma с транзакцией.
 */
export async function evaluateAutoClose(): Promise<{ closed: number }> {
    const tasks = await prisma.task.findMany({
        where: {
            isActive: true,
            scenario: { in: Object.keys(AUTO_CLOSE_REASONS) },
        },
        include: {
            driver: { select: { lastOrderAt: true, fullName: true } },
        },
    })

    if (tasks.length === 0) {
        console.log('[auto-close] No active churn/onboarding tasks found')
        return { closed: 0 }
    }

    let closed = 0

    for (const task of tasks) {
        const lastOrder = task.driver?.lastOrderAt
        if (!lastOrder) continue

        // Поездка появилась ПОСЛЕ создания задачи
        if (lastOrder <= task.createdAt) continue

        const closedReason = AUTO_CLOSE_REASONS[task.scenario!]
        if (!closedReason) continue

        const now = new Date()

        try {
            await prisma.$transaction([
                // 1. Закрываем задачу
                prisma.task.update({
                    where: { id: task.id },
                    data: {
                        status: 'done',
                        isActive: false,
                        resolvedAt: now,
                        resolvedBy: 'auto',
                        closedReason,
                    },
                }),
                // 2. Событие auto_closed
                prisma.taskEvent.create({
                    data: {
                        taskId: task.id,
                        eventType: 'auto_closed',
                        payload: {
                            reason: closedReason,
                            scenario: task.scenario,
                            lastOrderAt: lastOrder.toISOString(),
                        },
                        actorType: 'auto',
                        actorId: null,
                    },
                }),
                // 3. Событие status_changed (для единообразия истории)
                prisma.taskEvent.create({
                    data: {
                        taskId: task.id,
                        eventType: 'status_changed',
                        payload: {
                            from: task.status,
                            to: 'done',
                            auto: true,
                        },
                        actorType: 'auto',
                        actorId: null,
                    },
                }),
            ])

            console.log(
                `[auto-close] ✓ ${task.scenario} task ${task.id} closed (driver: ${task.driver?.fullName}, lastOrderAt: ${lastOrder.toISOString()})`
            )
            closed++
        } catch (err) {
            console.error(`[auto-close] ✗ Failed to close task ${task.id}:`, (err as Error).message)
        }
    }

    console.log(`[auto-close] Done: ${closed}/${tasks.length} tasks closed`)
    return { closed }
}

// ─── SLA Escalation ───────────────────────────────────────────────

/**
 * Escalate tasks that have breached their SLA deadline.
 * Creates a one-time `sla_escalated` event per task (dedup by checking existing events).
 *
 * Criteria:
 *   - task.isActive = true
 *   - task.slaDeadline < now  OR  task.dueAt < now (fallback)
 *   - no existing sla_escalated event for this task
 *
 * Uses direct Prisma (no cookies dependency — safe for cron context).
 */
export async function evaluateSLAEscalation(): Promise<{ escalated: number }> {
    const now = new Date()

    // Find active tasks past their SLA deadline or dueAt
    const candidates = await prisma.task.findMany({
        where: {
            isActive: true,
            OR: [
                { slaDeadline: { lt: now } },
                { dueAt: { lt: now } },
            ],
        },
        select: { id: true, slaDeadline: true, dueAt: true, scenario: true, stage: true, driverId: true },
    })

    if (candidates.length === 0) {
        console.log('[sla-escalation] No overdue tasks found')
        return { escalated: 0 }
    }

    // Batch check: which tasks already have sla_escalated events
    const alreadyEscalated = await prisma.taskEvent.findMany({
        where: {
            taskId: { in: candidates.map(t => t.id) },
            eventType: 'sla_escalated',
        },
        select: { taskId: true },
    })
    const escalatedSet = new Set(alreadyEscalated.map(e => e.taskId))

    const toEscalate = candidates.filter(t => !escalatedSet.has(t.id))

    if (toEscalate.length === 0) {
        console.log(`[sla-escalation] ${candidates.length} overdue tasks already escalated`)
        return { escalated: 0 }
    }

    let escalated = 0

    for (const task of toEscalate) {
        const deadline = task.slaDeadline || task.dueAt
        try {
            await prisma.taskEvent.create({
                data: {
                    taskId: task.id,
                    eventType: 'sla_escalated',
                    payload: {
                        slaDeadline: task.slaDeadline?.toISOString() || null,
                        dueAt: task.dueAt?.toISOString() || null,
                        scenario: task.scenario,
                        stage: task.stage,
                        overdueBy: deadline ? Math.round((now.getTime() - deadline.getTime()) / (1000 * 60 * 60)) + 'h' : null,
                    },
                    actorType: 'system',
                    actorId: null,
                },
            })
            console.log(`[sla-escalation] ✓ Task ${task.id} escalated (deadline: ${deadline?.toISOString()})`)
            escalated++
        } catch (err) {
            console.error(`[sla-escalation] ✗ Failed to escalate task ${task.id}:`, (err as Error).message)
        }
    }

    console.log(`[sla-escalation] Done: ${escalated}/${toEscalate.length} tasks escalated`)
    return { escalated }
}

// ─── Mandatory Follow-up Enforcement ─────────────────────────────────

/**
 * Enforce mandatory follow-up on high-risk tasks that have no nextActionId set.
 *
 * For each active task:
 *   1. Evaluate risk level (using evaluateTaskRisk)
 *   2. If risk = 'high' AND metadata.nextActionId is empty → enforce
 *   3. Set metadata.nextActionId = 'mandatory_followup'
 *   4. Set dueAt = now + followupDeadlineMinutes
 *   5. Log 'mandatory_followup' event (dedup: skip if event already exists)
 *
 * Uses direct Prisma (no cookies dependency — safe for cron context).
 * Idempotent: tasks already having nextActionId or existing event are skipped.
 */
export async function enforceMandatoryFollowup(): Promise<{ enforced: number }> {
    const now = new Date()

    // Get all active tasks with their metadata
    const activeTasks = await prisma.task.findMany({
        where: { isActive: true },
        select: {
            id: true,
            metadata: true,
            createdAt: true,
            slaDeadline: true,
        },
    })

    if (activeTasks.length === 0) {
        console.log('[followup] No active tasks found')
        return { enforced: 0 }
    }

    // Filter: only tasks without nextActionId
    const candidates = activeTasks.filter(t => {
        const meta = (t.metadata as Record<string, any>) || {}
        return !meta.nextActionId
    })

    if (candidates.length === 0) {
        console.log('[followup] All active tasks already have nextActionId')
        return { enforced: 0 }
    }

    const candidateIds = candidates.map(t => t.id)

    // Batch: check which tasks already have mandatory_followup events (dedup)
    const existingEvents = await prisma.taskEvent.findMany({
        where: {
            taskId: { in: candidateIds },
            eventType: 'mandatory_followup',
        },
        select: { taskId: true },
    })
    const alreadyEnforcedSet = new Set(existingEvents.map(e => e.taskId))

    // Batch: get reopened task IDs
    const reopenedEvents = await prisma.taskEvent.findMany({
        where: {
            taskId: { in: candidateIds },
            eventType: 'status_changed',
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

    // Batch: get first contact events
    const contactEvents = await prisma.taskEvent.findMany({
        where: {
            taskId: { in: candidateIds },
            eventType: { in: CONTACT_EVENT_TYPES },
        },
        select: { taskId: true },
    })
    const hasContactSet = new Set(contactEvents.map(e => e.taskId))

    let enforced = 0
    const deadlineMs = FOLLOWUP_THRESHOLDS.followupDeadlineMinutes * 60 * 1000

    for (const task of candidates) {
        if (alreadyEnforcedSet.has(task.id)) continue

        const meta = (task.metadata as Record<string, any>) || {}
        const attempts = meta.attempts || 0

        const risk = evaluateTaskRisk({
            attempts,
            isReopened: reopenedTaskIds.has(task.id),
            hasContact: hasContactSet.has(task.id),
            createdAt: task.createdAt,
            slaDeadline: task.slaDeadline,
            responseThresholdMinutes: RESPONSE_THRESHOLDS.maxResponseMinutes,
        })

        if (risk !== 'high') continue

        const newDueAt = new Date(now.getTime() + deadlineMs)

        try {
            await prisma.$transaction([
                // Set nextActionId and dueAt
                prisma.task.update({
                    where: { id: task.id },
                    data: {
                        metadata: {
                            ...meta,
                            nextActionId: FOLLOWUP_THRESHOLDS.mandatoryActionId,
                        },
                        dueAt: newDueAt,
                    },
                }),
                // Log enforcement event
                prisma.taskEvent.create({
                    data: {
                        taskId: task.id,
                        eventType: 'mandatory_followup',
                        payload: {
                            reason: 'high_risk',
                            attempts,
                            isReopened: reopenedTaskIds.has(task.id),
                            hasContact: hasContactSet.has(task.id),
                            deadlineMinutes: FOLLOWUP_THRESHOLDS.followupDeadlineMinutes,
                            dueAt: newDueAt.toISOString(),
                        },
                        actorType: 'system',
                        actorId: null,
                    },
                }),
            ])

            console.log(`[followup] ✓ Task ${task.id} enforced (attempts: ${attempts}, due: ${newDueAt.toISOString()})`)
            enforced++
        } catch (err) {
            console.error(`[followup] ✗ Failed to enforce task ${task.id}:`, (err as Error).message)
        }
    }

    console.log(`[followup] Done: ${enforced} tasks enforced`)
    return { enforced }
}

// ─── Escalation to Lead ──────────────────────────────────────────────

/**
 * Escalate high-risk tasks whose mandatory follow-up deadline has passed.
 *
 * Criteria:
 *   - task.isActive = true
 *   - metadata.nextActionId = 'mandatory_followup'
 *   - task.dueAt < now - escalateAfterMinutes
 *   - no existing 'escalation_created' event for this task
 *
 * Actions:
 *   - Create 'escalation_created' TaskEvent
 *   - Set metadata.escalated = true, metadata.escalatedAt = now
 *
 * Idempotent: tasks with existing escalation event are skipped.
 * Uses direct Prisma (no cookies — safe for cron context).
 */
export async function evaluateEscalations(): Promise<{ escalated: number }> {
    const now = new Date()
    const threshold = new Date(now.getTime() - ESCALATION_THRESHOLDS.escalateAfterMinutes * 60 * 1000)

    // Find active tasks with mandatory_followup that are past due
    const allActive = await prisma.task.findMany({
        where: {
            isActive: true,
            dueAt: { lt: threshold },
        },
        select: {
            id: true,
            metadata: true,
            dueAt: true,
            scenario: true,
            stage: true,
            assigneeId: true,
        },
    })

    // Filter: only tasks with nextActionId = mandatory_followup
    const candidates = allActive.filter(t => {
        const meta = (t.metadata as Record<string, any>) || {}
        return meta.nextActionId === FOLLOWUP_THRESHOLDS.mandatoryActionId
    })

    if (candidates.length === 0) {
        console.log('[escalation] No mandatory follow-up tasks past due')
        return { escalated: 0 }
    }

    const candidateIds = candidates.map(t => t.id)

    // Batch dedup: check existing escalation events
    const existingEvents = await prisma.taskEvent.findMany({
        where: {
            taskId: { in: candidateIds },
            eventType: 'escalation_created',
        },
        select: { taskId: true },
    })
    const alreadyEscalatedSet = new Set(existingEvents.map(e => e.taskId))

    const toEscalate = candidates.filter(t => !alreadyEscalatedSet.has(t.id))

    if (toEscalate.length === 0) {
        console.log(`[escalation] ${candidates.length} tasks already escalated`)
        return { escalated: 0 }
    }

    let escalated = 0

    for (const task of toEscalate) {
        const meta = (task.metadata as Record<string, any>) || {}

        try {
            await prisma.$transaction([
                // Set escalated flag in metadata
                prisma.task.update({
                    where: { id: task.id },
                    data: {
                        metadata: {
                            ...meta,
                            escalated: true,
                            escalatedAt: now.toISOString(),
                        },
                    },
                }),
                // Log escalation event
                prisma.taskEvent.create({
                    data: {
                        taskId: task.id,
                        eventType: 'escalation_created',
                        payload: {
                            reason: 'mandatory_followup_missed',
                            dueAt: task.dueAt?.toISOString() || null,
                            scenario: task.scenario,
                            stage: task.stage,
                            assigneeId: task.assigneeId,
                        },
                        actorType: 'system',
                        actorId: null,
                    },
                }),
            ])

            console.log(`[escalation] ✓ Task ${task.id} escalated (due was: ${task.dueAt?.toISOString()})`)
            escalated++
        } catch (err) {
            console.error(`[escalation] ✗ Failed to escalate task ${task.id}:`, (err as Error).message)
        }
    }

    console.log(`[escalation] Done: ${escalated} tasks escalated`)
    return { escalated }
}

// ─── Trigger → Scenario Mapping ────────────────────────────────────

function mapTriggerToScenario(condition: string): string {
    switch (condition) {
        case 'days_without_trips':
        case 'segment_sleeping':
        case 'segment_risk':
        case 'after_promotion':
            return 'churn'
        default:
            return 'churn'
    }
}

/**
 * Create a manager task from a trigger (legacy — kept for reference)
 */
async function createManagerTask(
    trigger: { id: string; name: string; condition: string },
    state: DriverState
) {
    // Map condition to task type and priority
    let type = 'contact_risk'
    let priority = 'medium'

    if (state.daysWithoutTrips >= 7) {
        priority = 'high'
    }

    if (trigger.condition === 'after_promotion') {
        type = 'contact_after_promo'
    } else if (trigger.condition === 'segment_sleeping') {
        type = 'contact_risk'
        priority = 'high'
    }

    const title = `${trigger.name} — ${state.fullName} (${state.daysWithoutTrips}д без поездок)`

    // Check if there's already an open task for this driver+trigger
    const existing = await prisma.managerTask.findFirst({
        where: {
            driverId: state.id,
            triggerId: trigger.id,
            status: 'open',
        },
    })

    if (existing) return // Don't create duplicate tasks

    await prisma.managerTask.create({
        data: {
            driverId: state.id,
            type,
            title,
            priority,
            triggerId: trigger.id,
            createdBy: 'system',
        },
    })
}
