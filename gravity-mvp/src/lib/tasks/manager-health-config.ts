/**
 * Manager Health Score configuration.
 * Penalties are subtracted from a base score of 100 per occurrence.
 * Adjustable without schema changes.
 */
export const HEALTH_HISTORY_CONFIG = {
    /** Default period for history visualization (days) */
    defaultPeriodDays: 7,
    /** Maximum allowed period (days) */
    maxPeriodDays: 30,
}

export const STABILITY_CONFIG = {
    /** Minimum number of managers with valid history to produce a signal */
    minDataPoints: 3,
    /** Per-manager change % above this = team improving */
    improvingThresholdPct: 5,
    /** Per-manager change % below this = team degrading (must be negative) */
    degradingThresholdPct: -5,
}

export type TeamStabilityStatus = 'improving' | 'stable' | 'degrading' | 'insufficient_data'

export interface TeamStabilityResult {
    status: TeamStabilityStatus
    changePct: number
    firstHalfAvg: number
    secondHalfAvg: number
    dataPoints: number
}

/**
 * Compute team-level stability from per-manager health history.
 * Pure, synchronous, deterministic, no side effects.
 *
 * Algorithm:
 * 1. For each manager, split their history into first half / second half
 * 2. Compute per-manager changePct = ((secondAvg - firstAvg) / firstAvg) * 100
 * 3. Average all per-manager changePct values → team changePct
 * 4. Classify by thresholds
 *
 * Returns 'insufficient_data' when fewer than minDataPoints managers have
 * enough history (≥2 points with both halves non-empty).
 */
export function computeTeamStability(
    healthHistory: Record<string, HealthHistoryPoint[]>
): TeamStabilityResult {
    const insufficient: TeamStabilityResult = {
        status: 'insufficient_data', changePct: 0,
        firstHalfAvg: 0, secondHalfAvg: 0, dataPoints: 0,
    }

    const managerChanges: number[] = []
    const managerFirstAvgs: number[] = []
    const managerSecondAvgs: number[] = []

    for (const points of Object.values(healthHistory)) {
        if (points.length < 2) continue

        // Sort ascending by time (should already be, but enforce)
        const sorted = [...points].sort(
            (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()
        )

        const mid = Math.floor(sorted.length / 2)
        const firstHalf = sorted.slice(0, mid)
        const secondHalf = sorted.slice(mid)

        if (firstHalf.length === 0 || secondHalf.length === 0) continue

        const firstAvg = firstHalf.reduce((s, p) => s + p.score, 0) / firstHalf.length
        const secondAvg = secondHalf.reduce((s, p) => s + p.score, 0) / secondHalf.length

        if (firstAvg === 0) continue // avoid division by zero

        const changePct = ((secondAvg - firstAvg) / firstAvg) * 100
        managerChanges.push(changePct)
        managerFirstAvgs.push(firstAvg)
        managerSecondAvgs.push(secondAvg)
    }

    if (managerChanges.length < STABILITY_CONFIG.minDataPoints) return insufficient

    const teamChangePct = managerChanges.reduce((s, v) => s + v, 0) / managerChanges.length
    const teamFirstAvg = managerFirstAvgs.reduce((s, v) => s + v, 0) / managerFirstAvgs.length
    const teamSecondAvg = managerSecondAvgs.reduce((s, v) => s + v, 0) / managerSecondAvgs.length

    let status: TeamStabilityStatus = 'stable'
    if (teamChangePct >= STABILITY_CONFIG.improvingThresholdPct) status = 'improving'
    else if (teamChangePct <= STABILITY_CONFIG.degradingThresholdPct) status = 'degrading'

    return {
        status,
        changePct: Math.round(teamChangePct * 10) / 10,
        firstHalfAvg: Math.round(teamFirstAvg * 10) / 10,
        secondHalfAvg: Math.round(teamSecondAvg * 10) / 10,
        dataPoints: managerChanges.length,
    }
}

export const RISK_PERSISTENCE_CONFIG = {
    /** Hours of continuous risk before flagging as sustained */
    sustainedRiskHours: 48,
    /** Health levels that count as "at risk" */
    riskLevels: ['warning', 'critical'] as readonly HealthLevel[],
}

export type RiskPersistenceStatus = 'sustained' | 'active' | 'clear'

export interface RiskPersistenceResult {
    status: RiskPersistenceStatus
    riskDurationHours: number
    riskSince: string | null
}

export interface TeamRiskProfileResult {
    sustained: number
    active: number
    clear: number
    totalManagers: number
    persistenceRatio: number
}

/**
 * Compute team-level risk profile from per-manager risk persistence.
 * Pure, synchronous, deterministic, no side effects.
 */
export function computeTeamRiskProfile(
    managers: { riskPersistence: RiskPersistenceResult }[]
): TeamRiskProfileResult | null {
    if (managers.length === 0) return null

    let sustained = 0
    let active = 0
    let clear = 0

    for (const m of managers) {
        switch (m.riskPersistence.status) {
            case 'sustained': sustained++; break
            case 'active': active++; break
            case 'clear': clear++; break
        }
    }

    const total = managers.length
    const persistenceRatio = total > 0
        ? Math.round((sustained / total) * 1000) / 10
        : 0

    return { sustained, active, clear, totalManagers: total, persistenceRatio }
}

/**
 * Compute risk persistence for a single manager from their history points.
 * Pure, synchronous, deterministic, no side effects.
 *
 * Walks backward from the most recent point, counting consecutive risk-level entries.
 * Continuity breaks when:
 * - a point is not in riskLevels
 * - the gap between adjacent points exceeds sustainedRiskHours
 *
 * Duration is computed from the earliest continuous risk point to the latest
 * observed point timestamp (not NOW).
 */
export function computeRiskPersistence(points: HealthHistoryPoint[]): RiskPersistenceResult {
    const clear: RiskPersistenceResult = { status: 'clear', riskDurationHours: 0, riskSince: null }

    if (points.length < 2) return clear

    // Sort ascending by time (enforce)
    const sorted = [...points].sort(
        (a, b) => a.recordedAt.getTime() - b.recordedAt.getTime()
    )

    const latest = sorted[sorted.length - 1]
    const riskLevels = RISK_PERSISTENCE_CONFIG.riskLevels as readonly string[]

    // If latest point is not at risk → clear
    if (!riskLevels.includes(latest.healthLevel)) return clear

    // Walk backward from latest, find the continuous risk tail
    const maxGapMs = RISK_PERSISTENCE_CONFIG.sustainedRiskHours * 60 * 60 * 1000
    let earliestRiskIdx = sorted.length - 1

    for (let i = sorted.length - 2; i >= 0; i--) {
        // Check if this point is at risk
        if (!riskLevels.includes(sorted[i].healthLevel)) break

        // Check continuity gap: gap between sorted[i] and sorted[i+1]
        const gapMs = sorted[i + 1].recordedAt.getTime() - sorted[i].recordedAt.getTime()
        if (gapMs > maxGapMs) break

        earliestRiskIdx = i
    }

    const riskSince = sorted[earliestRiskIdx].recordedAt
    const durationMs = latest.recordedAt.getTime() - riskSince.getTime()
    const durationHours = Math.round(durationMs / (60 * 60 * 1000) * 10) / 10

    const thresholdHours = RISK_PERSISTENCE_CONFIG.sustainedRiskHours
    const status: RiskPersistenceStatus = durationHours >= thresholdHours ? 'sustained' : 'active'

    return {
        status,
        riskDurationHours: durationHours,
        riskSince: riskSince.toISOString(),
    }
}

export interface HealthHistoryPoint {
    score: number
    healthLevel: HealthLevel
    recordedAt: Date
}

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
    /** Minimum score change to register as a trend (not "stable") */
    trendSensitivity: 3,
    /** Consecutive declining checks before flagging sustained decline */
    declineStreakThreshold: 3,
}

export type HealthLevel = 'healthy' | 'warning' | 'critical'
export type HealthTrend = 'improving' | 'declining' | 'stable'

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

/**
 * Determine health trend by comparing current vs previous score.
 */
export function calculateHealthTrend(current: number, previous: number | null): HealthTrend {
    if (previous === null) return 'stable'
    const delta = current - previous
    const sensitivity = HEALTH_SCORE_CONFIG.trendSensitivity
    if (delta >= sensitivity) return 'improving'
    if (delta <= -sensitivity) return 'declining'
    return 'stable'
}

// ─── Snapshot data shapes ──────────────────────────────────

export interface HealthSnapshot {
    managerId: string
    score: number
    declineStreak: number
    healthLevel: HealthLevel
}

export interface PreviousHealthData {
    score: number
    declineStreak: number
}

/**
 * Calculate updated decline streak based on current trend.
 */
export function updateDeclineStreak(trend: HealthTrend, previousStreak: number): number {
    return trend === 'declining' ? previousStreak + 1 : 0
}

/**
 * Check if manager is in sustained decline.
 */
export function isSustainedDecline(declineStreak: number): boolean {
    return declineStreak >= HEALTH_SCORE_CONFIG.declineStreakThreshold
}
