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
