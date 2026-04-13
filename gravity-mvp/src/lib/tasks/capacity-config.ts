/**
 * Team capacity visibility configuration.
 * Classifies managers by workload pressure level.
 */

export const CAPACITY_CONFIG = {
    /** Active tasks >= this = high pressure (when not already overloaded) */
    highPressureThreshold: 15,
    /** Active tasks <= this = low utilization (when not overloaded or high pressure) */
    lowUtilizationThreshold: 3,
}

export type ManagerCapacityLevel = 'overloaded' | 'high_pressure' | 'balanced' | 'low_utilization'

export interface TeamCapacityResult {
    overloaded: number
    highPressure: number
    balanced: number
    lowUtilization: number
    totalManagers: number
    totalActive: number
    avgActive: number
    maxActive: number
    maxManagerName: string | null
    distributionSkew: number
}

/**
 * Compute team capacity distribution from already-available manager data.
 * Pure, synchronous, deterministic, no side effects.
 *
 * Classification priority: overloaded → high_pressure → low_utilization → balanced
 */
export function computeTeamCapacity(
    managers: { active: number; overdue: number; isOverloaded: boolean; managerName: string }[]
): TeamCapacityResult | null {
    if (managers.length === 0) return null

    const cfg = CAPACITY_CONFIG
    let overloaded = 0
    let highPressure = 0
    let balanced = 0
    let lowUtilization = 0
    let totalActive = 0
    let maxActive = 0
    let maxManagerName: string | null = null

    for (const m of managers) {
        totalActive += m.active

        if (m.active > maxActive || maxManagerName === null) {
            maxActive = m.active
            maxManagerName = m.managerName
        }

        if (m.isOverloaded) {
            overloaded++
        } else if (m.active >= cfg.highPressureThreshold) {
            highPressure++
        } else if (m.active <= cfg.lowUtilizationThreshold) {
            lowUtilization++
        } else {
            balanced++
        }
    }

    const avgActive = Math.round((totalActive / managers.length) * 10) / 10
    const distributionSkew = avgActive > 0
        ? Math.round((maxActive / avgActive) * 10) / 10
        : 0

    return {
        overloaded,
        highPressure,
        balanced,
        lowUtilization,
        totalManagers: managers.length,
        totalActive,
        avgActive,
        maxActive,
        maxManagerName,
        distributionSkew,
    }
}
