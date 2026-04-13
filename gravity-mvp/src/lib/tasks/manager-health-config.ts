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

// ─── Snapshot persistence (raw SQL, no migrations) ──────────

import { prisma } from '@/lib/prisma'

const ENSURE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS health_snapshots (
  manager_id TEXT PRIMARY KEY,
  score INTEGER NOT NULL,
  decline_streak INTEGER NOT NULL DEFAULT 0,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_COLUMN_SQL = `
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'health_snapshots' AND column_name = 'decline_streak'
  ) THEN
    ALTER TABLE health_snapshots ADD COLUMN decline_streak INTEGER NOT NULL DEFAULT 0;
  END IF;
END $$`

const ENSURE_HISTORY_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS health_score_history (
  id SERIAL PRIMARY KEY,
  manager_id TEXT NOT NULL,
  score INTEGER NOT NULL,
  health_level TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

const ENSURE_HISTORY_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_hsh_manager_date
  ON health_score_history (manager_id, recorded_at DESC)`

let tableEnsured = false

async function ensureTable() {
    if (tableEnsured) return
    await prisma.$executeRawUnsafe(ENSURE_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_COLUMN_SQL)
    await prisma.$executeRawUnsafe(ENSURE_HISTORY_TABLE_SQL)
    await prisma.$executeRawUnsafe(ENSURE_HISTORY_INDEX_SQL)
    tableEnsured = true
}

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
 * Read previous health scores and decline streaks for all managers.
 */
export async function getPreviousHealthScores(): Promise<Map<string, PreviousHealthData>> {
    await ensureTable()
    const rows: { manager_id: string; score: number; decline_streak: number }[] =
        await prisma.$queryRawUnsafe('SELECT manager_id, score, decline_streak FROM health_snapshots')
    const map = new Map<string, PreviousHealthData>()
    for (const r of rows) map.set(r.manager_id, { score: r.score, declineStreak: r.decline_streak })
    return map
}

/**
 * Upsert current health scores with decline streaks.
 * Also appends to health_score_history (max 1 record per manager per hour).
 * History write is failure-tolerant — main upsert always completes.
 */
export async function saveHealthScores(snapshots: HealthSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return
    await ensureTable()

    // 1. Primary upsert (existing behavior, untouched)
    const values = snapshots
        .map(s => `('${s.managerId}', ${s.score}, ${s.declineStreak}, NOW())`)
        .join(', ')
    await prisma.$executeRawUnsafe(`
        INSERT INTO health_snapshots (manager_id, score, decline_streak, recorded_at)
        VALUES ${values}
        ON CONFLICT (manager_id) DO UPDATE SET
          score = EXCLUDED.score,
          decline_streak = EXCLUDED.decline_streak,
          recorded_at = NOW()
    `)

    // 2. Append to history (failure-tolerant, 1-hour dedup)
    try {
        const historyValues = snapshots
            .map(s => `('${s.managerId}', ${s.score}, '${s.healthLevel}')`)
            .join(', ')
        await prisma.$executeRawUnsafe(`
            INSERT INTO health_score_history (manager_id, score, health_level, recorded_at)
            SELECT v.manager_id, v.score, v.health_level, NOW()
            FROM (VALUES ${historyValues}) AS v(manager_id, score, health_level)
            WHERE NOT EXISTS (
              SELECT 1 FROM health_score_history h
              WHERE h.manager_id = v.manager_id
                AND h.recorded_at > NOW() - INTERVAL '1 hour'
            )
        `)
    } catch (e) {
        console.error('[health-history] Failed to write history, continuing:', e)
    }
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

/**
 * Read health score history for given managers within a time window.
 * Returns raw points sorted ascending by recorded_at.
 * Failure-tolerant: returns empty map on error.
 */
export async function getHealthHistory(
    managerIds: string[],
    periodDays?: number
): Promise<Map<string, HealthHistoryPoint[]>> {
    const result = new Map<string, HealthHistoryPoint[]>()
    if (managerIds.length === 0) return result

    try {
        await ensureTable()
        const days = Math.min(
            periodDays ?? HEALTH_HISTORY_CONFIG.defaultPeriodDays,
            HEALTH_HISTORY_CONFIG.maxPeriodDays
        )

        const rows: { manager_id: string; score: number; health_level: string; recorded_at: Date }[] =
            await prisma.$queryRawUnsafe(`
                SELECT manager_id, score, health_level, recorded_at
                FROM health_score_history
                WHERE manager_id = ANY($1)
                  AND recorded_at >= NOW() - INTERVAL '${days} days'
                ORDER BY manager_id, recorded_at ASC
            `, managerIds)

        for (const r of rows) {
            if (!result.has(r.manager_id)) result.set(r.manager_id, [])
            result.get(r.manager_id)!.push({
                score: r.score,
                healthLevel: r.health_level as HealthLevel,
                recordedAt: r.recorded_at,
            })
        }
    } catch (e) {
        console.error('[health-history] Failed to read history, returning empty:', e)
    }

    return result
}
