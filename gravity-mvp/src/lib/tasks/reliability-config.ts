/**
 * Process reliability pressure configuration.
 * Measures current operational reliability based on incident pressure
 * relative to active work volume. This is a pressure proxy, not a
 * completed-task quality metric.
 */

export const RELIABILITY_CONFIG = {
    /** Clean rate >= this = reliable (green) */
    reliableThresholdPct: 80,
    /** Clean rate >= this = pressured (yellow); below = degraded (red) */
    pressuredThresholdPct: 60,
}

export type ReliabilityStatus = 'reliable' | 'pressured' | 'degraded' | 'no_data'

export interface ProcessReliabilityResult {
    status: ReliabilityStatus
    cleanRate: number
    incidentRate: number
    totalActive: number
    totalIncidents: number
}

/**
 * Compute current process reliability pressure from manager state.
 * Pure, synchronous, deterministic, no side effects.
 *
 * rawIncidentCount = overdue + escalated + reopened (bounded pressure signal,
 * not unique task count — one task may contribute to multiple incident types).
 * totalIncidents = min(rawIncidentCount, totalActive) to prevent rates > 100%.
 */
export function computeProcessReliability(
    managers: { active: number; overdue: number; escalated: number; reopened: number }[]
): ProcessReliabilityResult {
    const noData: ProcessReliabilityResult = {
        status: 'no_data', cleanRate: 0, incidentRate: 0, totalActive: 0, totalIncidents: 0,
    }

    let totalActive = 0
    let rawIncidents = 0

    for (const m of managers) {
        totalActive += m.active
        rawIncidents += m.overdue + m.escalated + m.reopened
    }

    if (totalActive === 0) return noData

    const totalIncidents = Math.min(rawIncidents, totalActive)
    const incidentRate = Math.round((totalIncidents / totalActive) * 1000) / 10
    const cleanRate = Math.max(0, Math.round((100 - incidentRate) * 10) / 10)

    let status: ReliabilityStatus = 'degraded'
    if (cleanRate >= RELIABILITY_CONFIG.reliableThresholdPct) status = 'reliable'
    else if (cleanRate >= RELIABILITY_CONFIG.pressuredThresholdPct) status = 'pressured'

    return { status, cleanRate, incidentRate, totalActive, totalIncidents }
}
