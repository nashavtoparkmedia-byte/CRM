/**
 * Manager Health Score configuration.
 * Penalties are subtracted from a base score of 100 per occurrence.
 * Adjustable without schema changes.
 */
export const HEALTH_SCORE_CONFIG = {
    /** Penalty per overdue task */
    overduePenalty: 8,
    /** Penalty per escalated task */
    escalatedPenalty: 12,
    /** Penalty per late response */
    lateResponsePenalty: 5,
    /** Penalty per reopened task */
    reopenedPenalty: 6,
    /** Penalty per fast-closed task */
    fastClosePenalty: 4,
    /** Penalty per high-risk task */
    highRiskPenalty: 7,
    /** Penalty if manager is overloaded */
    overloadPenalty: 10,
    /** Score >= this = healthy (green) */
    warningThreshold: 70,
    /** Score >= this but < warningThreshold = warning (yellow); < this = critical (red) */
    criticalThreshold: 45,
}

export type HealthLevel = 'healthy' | 'warning' | 'critical'

export interface HealthScoreBreakdown {
    overdue: number
    escalated: number
    lateResponses: number
    reopened: number
    fastClosed: number
    highRisk: number
    overload: number
}

export interface HealthScoreResult {
    score: number
    level: HealthLevel
    breakdown: HealthScoreBreakdown
}

/**
 * Calculate manager health score from operational metrics.
 * Base score: 100, penalties subtracted per occurrence. Floor: 0.
 */
export function calculateManagerHealthScore(params: {
    overdue: number
    escalated: number
    lateResponses: number
    reopened: number
    fastClosed: number
    highRiskTasks: number
    isOverloaded: boolean
}): HealthScoreResult {
    const cfg = HEALTH_SCORE_CONFIG

    const breakdown: HealthScoreBreakdown = {
        overdue: params.overdue * cfg.overduePenalty,
        escalated: params.escalated * cfg.escalatedPenalty,
        lateResponses: params.lateResponses * cfg.lateResponsePenalty,
        reopened: params.reopened * cfg.reopenedPenalty,
        fastClosed: params.fastClosed * cfg.fastClosePenalty,
        highRisk: params.highRiskTasks * cfg.highRiskPenalty,
        overload: params.isOverloaded ? cfg.overloadPenalty : 0,
    }

    const totalPenalty = breakdown.overdue + breakdown.escalated + breakdown.lateResponses
        + breakdown.reopened + breakdown.fastClosed + breakdown.highRisk + breakdown.overload

    const score = Math.max(0, 100 - totalPenalty)

    let level: HealthLevel = 'healthy'
    if (score < cfg.criticalThreshold) level = 'critical'
    else if (score < cfg.warningThreshold) level = 'warning'

    return { score, level, breakdown }
}
