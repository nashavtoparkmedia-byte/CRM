/**
 * Operational volatility configuration.
 * Measures health score variability per manager using coefficient of variation (CV).
 * Team-level volatility = average of per-manager CVs (equal weighting).
 * Pure, synchronous, deterministic — no queries, no side effects.
 */

export const VOLATILITY_CONFIG = {
    /** Minimum history points per manager to include in volatility calculation */
    minPointsPerManager: 4,
    /** Minimum managers with valid data to produce a team signal */
    minManagers: 2,
    /** CV threshold: below this = calm */
    calmMaxCv: 8,
    /** CV threshold: above this = volatile (between calm and volatile = moderate) */
    volatileMinCv: 20,
}

export type VolatilityStatus = 'calm' | 'moderate' | 'volatile' | 'insufficient_data'

export interface OperationalVolatilityResult {
    status: VolatilityStatus
    teamCv: number
    managersIncluded: number
}

export interface VolatilityHistoryInput {
    score: number
}

/**
 * Compute coefficient of variation for a single manager's score series.
 * Returns null if insufficient data points.
 */
function computeCv(scores: number[]): number | null {
    if (scores.length < VOLATILITY_CONFIG.minPointsPerManager) return null
    const n = scores.length
    const mean = scores.reduce((s, v) => s + v, 0) / n
    if (mean === 0) return 0
    const variance = scores.reduce((s, v) => s + (v - mean) ** 2, 0) / n
    const stdDev = Math.sqrt(variance)
    return Math.round((stdDev / mean) * 1000) / 10 // percentage with 1 decimal
}

/**
 * Compute team operational volatility from per-manager health history.
 * Input: map of managerId → array of {score} points.
 * Pure, synchronous, deterministic.
 */
export function computeOperationalVolatility(
    historyMap: Record<string, VolatilityHistoryInput[]>
): OperationalVolatilityResult {
    const cvValues: number[] = []

    for (const scores of Object.values(historyMap)) {
        const cv = computeCv(scores.map(p => p.score))
        if (cv !== null) cvValues.push(cv)
    }

    if (cvValues.length < VOLATILITY_CONFIG.minManagers) {
        return { status: 'insufficient_data', teamCv: 0, managersIncluded: 0 }
    }

    const teamCv = Math.round((cvValues.reduce((s, v) => s + v, 0) / cvValues.length) * 10) / 10

    let status: VolatilityStatus
    if (teamCv <= VOLATILITY_CONFIG.calmMaxCv) {
        status = 'calm'
    } else if (teamCv >= VOLATILITY_CONFIG.volatileMinCv) {
        status = 'volatile'
    } else {
        status = 'moderate'
    }

    return { status, teamCv, managersIncluded: cvValues.length }
}
