// Trigger evaluation engine — checks conditions and executes actions

import { prisma } from '@/lib/prisma'
import { logCommunicationEvent } from './communications'
import { sendTelegramMessage } from '@/app/tg-actions'

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
                    await createManagerTask(trigger, state)
                    tasksCreated++
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
 * Create a manager task from a trigger
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
