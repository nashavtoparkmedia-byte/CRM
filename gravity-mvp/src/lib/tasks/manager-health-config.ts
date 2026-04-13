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
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`

let tableEnsured = false

async function ensureTable() {
    if (tableEnsured) return
    await prisma.$executeRawUnsafe(ENSURE_TABLE_SQL)
    tableEnsured = true
}

export interface HealthSnapshot {
    managerId: string
    score: number
}

/**
 * Read previous health scores for all managers.
 */
export async function getPreviousHealthScores(): Promise<Map<string, number>> {
    await ensureTable()
    const rows: { manager_id: string; score: number }[] =
        await prisma.$queryRawUnsafe('SELECT manager_id, score FROM health_snapshots')
    const map = new Map<string, number>()
    for (const r of rows) map.set(r.manager_id, r.score)
    return map
}

/**
 * Upsert current health scores (replaces previous snapshot).
 */
export async function saveHealthScores(snapshots: HealthSnapshot[]): Promise<void> {
    if (snapshots.length === 0) return
    await ensureTable()
    // Build upsert for each manager
    const values = snapshots
        .map(s => `('${s.managerId}', ${s.score}, NOW())`)
        .join(', ')
    await prisma.$executeRawUnsafe(`
        INSERT INTO health_snapshots (manager_id, score, recorded_at)
        VALUES ${values}
        ON CONFLICT (manager_id) DO UPDATE SET score = EXCLUDED.score, recorded_at = NOW()
    `)
}
