/**
 * Performance Safeguards — execution time monitoring for key operations.
 *
 * Tracks operation duration, detects slow executions, logs warnings.
 * Configurable thresholds per operation type.
 * Monitoring only — never blocks or modifies operations.
 */

import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'

export const PERF_CONFIG = {
    /** Default slow operation threshold (ms) */
    defaultSlowThresholdMs: 5000,
    /** Slow threshold for cron jobs (ms) */
    cronSlowThresholdMs: 30000,
    /** Slow threshold for API requests (ms) */
    apiSlowThresholdMs: 3000,
    /** Slow threshold for DB queries (ms) */
    querySlowThresholdMs: 2000,
    /** Maximum entries to keep in perf_log per cleanup cycle */
    maxLogEntries: 10000,
    /** Retention period for perf_log (days) */
    retentionDays: 7,
}

export type OperationType = 'cron' | 'api' | 'query' | 'background' | 'other'

export interface PerfEntry {
    operationName: string
    operationType: OperationType
    durationMs: number
    isSlow: boolean
    timestamp: Date
    metadata?: Record<string, unknown>
}

let tableEnsured = false

async function ensureTable(): Promise<void> {
    if (tableEnsured) return
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS perf_log (
                id SERIAL PRIMARY KEY,
                operation_name TEXT NOT NULL,
                operation_type TEXT NOT NULL DEFAULT 'other',
                duration_ms INT NOT NULL,
                is_slow BOOLEAN NOT NULL DEFAULT false,
                logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                metadata JSONB
            )
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_perf_log_time
            ON perf_log (logged_at DESC)
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_perf_log_slow
            ON perf_log (is_slow, logged_at DESC) WHERE is_slow = true
        `)
        tableEnsured = true
    } catch { /* non-blocking */ }
}

/**
 * Get the slow threshold for a given operation type.
 */
function getSlowThreshold(opType: OperationType): number {
    switch (opType) {
        case 'cron': return PERF_CONFIG.cronSlowThresholdMs
        case 'api': return PERF_CONFIG.apiSlowThresholdMs
        case 'query': return PERF_CONFIG.querySlowThresholdMs
        default: return PERF_CONFIG.defaultSlowThresholdMs
    }
}

/**
 * Record an operation's execution time. Fail-safe — never throws.
 * Automatically flags slow operations and logs warnings.
 */
export async function recordPerf(entry: {
    operationName: string
    operationType: OperationType
    durationMs: number
    metadata?: Record<string, unknown>
}): Promise<void> {
    const threshold = getSlowThreshold(entry.operationType)
    const isSlow = entry.durationMs >= threshold

    if (isSlow) {
        opsLog('warn', 'slow_operation', {
            operation: entry.operationName,
            durationMs: entry.durationMs,
        })
    }

    try {
        await ensureTable()
        await prisma.$executeRawUnsafe(
            `INSERT INTO perf_log (operation_name, operation_type, duration_ms, is_slow, logged_at, metadata)
             VALUES ($1, $2, $3, $4, NOW(), $5)`,
            entry.operationName,
            entry.operationType,
            entry.durationMs,
            isSlow,
            entry.metadata ? JSON.stringify(entry.metadata) : null
        )
    } catch { /* non-blocking */ }
}

/**
 * Measure and record a function's execution time.
 *
 * Usage:
 *   const result = await measurePerf('get-team-overview', 'api', async () => {
 *       return await getTeamOverview()
 *   })
 */
export async function measurePerf<T>(
    operationName: string,
    operationType: OperationType,
    fn: () => Promise<T>
): Promise<T> {
    const start = Date.now()
    try {
        const result = await fn()
        const durationMs = Date.now() - start
        recordPerf({ operationName, operationType, durationMs }).catch(() => {})
        return result
    } catch (error) {
        const durationMs = Date.now() - start
        recordPerf({
            operationName,
            operationType,
            durationMs,
            metadata: { error: (error as Error).message },
        }).catch(() => {})
        throw error
    }
}

/**
 * Get recent slow operations (for dashboard).
 */
export async function getSlowOperations(
    limit: number = 20,
    hours: number = 24
): Promise<SlowOperationEntry[]> {
    try {
        await ensureTable()
        return await prisma.$queryRawUnsafe<SlowOperationEntry[]>(
            `SELECT operation_name as "operationName",
                    operation_type as "operationType",
                    duration_ms as "durationMs",
                    logged_at as "loggedAt",
                    metadata
             FROM perf_log
             WHERE is_slow = true
               AND logged_at > NOW() - INTERVAL '1 hour' * $1
             ORDER BY logged_at DESC
             LIMIT $2`,
            hours,
            limit
        )
    } catch {
        return []
    }
}

/**
 * Get performance summary per operation (for dashboard).
 */
export async function getPerfSummary(
    hours: number = 24
): Promise<PerfSummaryEntry[]> {
    try {
        await ensureTable()
        return await prisma.$queryRawUnsafe<PerfSummaryEntry[]>(
            `SELECT
                operation_name as "operationName",
                operation_type as "operationType",
                COUNT(*)::int as "totalRuns",
                COUNT(*) FILTER (WHERE is_slow)::int as "slowRuns",
                ROUND(AVG(duration_ms))::int as "avgDurationMs",
                MAX(duration_ms)::int as "maxDurationMs",
                ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms))::int as "p95DurationMs"
             FROM perf_log
             WHERE logged_at > NOW() - INTERVAL '1 hour' * $1
             GROUP BY operation_name, operation_type
             ORDER BY MAX(duration_ms) DESC`,
            hours
        )
    } catch {
        return []
    }
}

/**
 * Clean old perf_log entries. Called by retention job.
 */
export async function cleanPerfLog(): Promise<{ deleted: number }> {
    try {
        await ensureTable()
        const result = await prisma.$executeRawUnsafe(
            `DELETE FROM perf_log WHERE logged_at < NOW() - INTERVAL '1 day' * $1`,
            PERF_CONFIG.retentionDays
        )
        return { deleted: result as number }
    } catch {
        return { deleted: 0 }
    }
}

export interface SlowOperationEntry {
    operationName: string
    operationType: string
    durationMs: number
    loggedAt: Date
    metadata: unknown
}

export interface PerfSummaryEntry {
    operationName: string
    operationType: string
    totalRuns: number
    slowRuns: number
    avgDurationMs: number
    maxDurationMs: number
    p95DurationMs: number
}
