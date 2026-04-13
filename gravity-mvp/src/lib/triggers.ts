// Trigger evaluation engine — checks conditions and executes actions

import { prisma } from '@/lib/prisma'
import { logCommunicationEvent } from './communications'
import { sendTelegramMessage } from '@/app/tg-actions'
import { createTask } from '@/app/tasks/actions'
import { getScenario } from '@/lib/tasks/scenario-config'

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
