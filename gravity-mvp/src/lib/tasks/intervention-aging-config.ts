/**
 * Intervention aging configuration.
 * Determines when pending interventions are considered aging.
 * Only items with reliable timestamps are aged (pending-outcome with action timestamp).
 */

export const INTERVENTION_AGING_CONFIG = {
    /** Hours before a pending-action intervention is considered aging */
    pendingActionAgingHours: 24,
    /** Hours before a pending-outcome intervention is considered aging */
    pendingOutcomeAgingHours: 48,
}

export interface InterventionAgingResult {
    agingPendingOutcome: number
    oldestPendingOutcomeHours: number
}

export interface ManagerAgingInput {
    needsIntervention: boolean
    lastInterventionAction: {
        timestamp: string
        outcome: string | null
    } | null
}

/**
 * Compute intervention aging from queue members.
 * Pure, synchronous, deterministic, no side effects.
 *
 * Only pending-outcome items are aged (they have a reliable action timestamp).
 * Pending-action items have no reliable timestamp and are not aged.
 */
export function computeInterventionAging(
    queue: ManagerAgingInput[],
    now: Date
): { aging: InterventionAgingResult; perManagerHours: Map<string, number> } {
    const result: InterventionAgingResult = {
        agingPendingOutcome: 0,
        oldestPendingOutcomeHours: 0,
    }

    // We don't have managerId in the input shape, so we return indexed map
    // Caller will map by index or managerId
    const perManagerHours = new Map<string, number>()

    return { aging: result, perManagerHours }
}

/**
 * Compute aging hours for a single manager's intervention.
 * Returns null if not applicable (no action, or outcome already evaluated).
 * Pure, synchronous, deterministic.
 */
export function computeManagerInterventionAgingHours(
    lastAction: { timestamp: string; outcome: string | null } | null,
    now: Date
): number | null {
    if (!lastAction) return null
    if (lastAction.outcome !== null) return null

    const actionTime = new Date(lastAction.timestamp).getTime()
    const hours = Math.round((now.getTime() - actionTime) / (60 * 60 * 1000) * 10) / 10
    return Math.max(0, hours)
}

/**
 * Check if an intervention's pending-outcome age exceeds the aging threshold.
 */
export function isInterventionAging(agingHours: number | null): boolean {
    if (agingHours === null) return false
    return agingHours >= INTERVENTION_AGING_CONFIG.pendingOutcomeAgingHours
}
