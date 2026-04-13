/**
 * Cron Health Monitoring — persistent execution logging.
 *
 * Records every cron/background job execution with status, duration, and errors.
 * Table auto-created on first use. Failure to log never interrupts execution.
 */

import { prisma } from '@/lib/prisma'
import { NextResponse } from 'next/server'

let tableEnsured = false

/**
 * Ensure cron_health_log table exists. Idempotent, called once per process.
 */
async function ensureTable(): Promise<void> {
    if (tableEnsured) return
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS cron_health_log (
                id SERIAL PRIMARY KEY,
                cron_name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'ok',
                executed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                duration_ms INT NOT NULL DEFAULT 0,
                error_message TEXT,
                metadata JSONB
            )
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_cron_health_log_name_time
            ON cron_health_log (cron_name, executed_at DESC)
        `)
        tableEnsured = true
    } catch {
        // Non-blocking: if table creation fails, logging will silently skip
    }
}

/**
 * Log a cron execution result. Fail-safe — never throws.
 */
export async function logCronHealth(entry: {
    cronName: string
    status: 'ok' | 'error' | 'skipped'
    durationMs: number
    errorMessage?: string | null
    metadata?: Record<string, unknown> | null
}): Promise<void> {
    try {
        await ensureTable()
        await prisma.$executeRawUnsafe(
            `INSERT INTO cron_health_log (cron_name, status, executed_at, duration_ms, error_message, metadata)
             VALUES ($1, $2, NOW(), $3, $4, $5::jsonb)`,
            entry.cronName,
            entry.status,
            entry.durationMs,
            entry.errorMessage ?? null,
            entry.metadata ? JSON.stringify(entry.metadata) : null
        )
    } catch {
        // Fail-safe: never interrupt business logic
    }
}

/**
 * Wrap a cron API handler with automatic health logging.
 *
 * Usage:
 *   export const GET = withCronLogging('auto-close-tasks', async () => {
 *       const result = await evaluateAutoClose()
 *       return { ok: true, ...result }
 *   })
 */
export function withCronLogging(
    cronName: string,
    handler: () => Promise<Record<string, unknown>>
): () => Promise<NextResponse> {
    return async () => {
        const start = Date.now()
        try {
            const result = await handler()
            const durationMs = Date.now() - start

            // Fire-and-forget logging — don't await to avoid slowing response
            logCronHealth({
                cronName,
                status: 'ok',
                durationMs,
                metadata: result,
            }).catch(() => {})

            return NextResponse.json({
                ...result,
                timestamp: new Date().toISOString(),
            })
        } catch (error: any) {
            const durationMs = Date.now() - start
            const errorMessage = error.message || String(error)

            console.error(`[cron/${cronName}] Error:`, errorMessage)

            logCronHealth({
                cronName,
                status: 'error',
                durationMs,
                errorMessage,
            }).catch(() => {})

            return NextResponse.json(
                { ok: false, error: errorMessage },
                { status: 500 }
            )
        }
    }
}

/**
 * Query recent cron health entries for a given job.
 * Used by health dashboard. Fail-safe — returns empty on error.
 */
export async function getCronHealthRecent(
    cronName: string,
    limit: number = 20
): Promise<CronHealthEntry[]> {
    try {
        await ensureTable()
        const rows = await prisma.$queryRawUnsafe<CronHealthEntry[]>(
            `SELECT id, cron_name as "cronName", status, executed_at as "executedAt",
                    duration_ms as "durationMs", error_message as "errorMessage"
             FROM cron_health_log
             WHERE cron_name = $1
             ORDER BY executed_at DESC
             LIMIT $2`,
            cronName,
            limit
        )
        return rows
    } catch {
        return []
    }
}

/**
 * Query summary stats for all crons in last N hours.
 * Used by system health dashboard.
 */
export async function getCronHealthSummary(
    hours: number = 24
): Promise<CronHealthSummaryEntry[]> {
    try {
        await ensureTable()
        const rows = await prisma.$queryRawUnsafe<CronHealthSummaryEntry[]>(
            `SELECT
                cron_name as "cronName",
                COUNT(*)::int as "totalRuns",
                COUNT(*) FILTER (WHERE status = 'ok')::int as "okRuns",
                COUNT(*) FILTER (WHERE status = 'error')::int as "errorRuns",
                COUNT(*) FILTER (WHERE status = 'skipped')::int as "skippedRuns",
                ROUND(AVG(duration_ms))::int as "avgDurationMs",
                MAX(executed_at) as "lastExecutedAt",
                MAX(CASE WHEN status = 'error' THEN error_message END) as "lastError"
             FROM cron_health_log
             WHERE executed_at > NOW() - INTERVAL '1 hour' * $1
             GROUP BY cron_name
             ORDER BY cron_name`,
            hours
        )
        return rows
    } catch {
        return []
    }
}

export interface CronHealthEntry {
    id: number
    cronName: string
    status: string
    executedAt: Date
    durationMs: number
    errorMessage: string | null
}

export interface CronHealthSummaryEntry {
    cronName: string
    totalRuns: number
    okRuns: number
    errorRuns: number
    skippedRuns: number
    avgDurationMs: number
    lastExecutedAt: Date
    lastError: string | null
}
