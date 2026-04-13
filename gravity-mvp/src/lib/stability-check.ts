/**
 * Stability Check — automated routine monitoring utility.
 *
 * Produces a structured stability report from existing reliability signals.
 * Non-invasive, read-only. No configuration changes.
 * Supports daily, weekly, and monthly check scopes.
 */

import { prisma } from '@/lib/prisma'
import { getCronHealthSummary } from '@/lib/cron-health'
import { detectFailures, type AlertStatus } from '@/lib/failure-detection'
import { getSlowOperations, getPerfSummary } from '@/lib/perf-monitor'
import { getActiveLocks } from '@/lib/execution-lock'
import { IntegrityChecker } from '@/lib/IntegrityChecker'

export type CheckScope = 'daily' | 'weekly' | 'monthly'

export type StabilityStatus = 'stable' | 'warning' | 'critical' | 'unknown'

export interface StabilityAnomaly {
    subsystem: string
    severity: 'warning' | 'critical'
    description: string
}

export interface StabilityReport {
    scope: CheckScope
    status: StabilityStatus
    timestamp: string
    anomalies: StabilityAnomaly[]
    subsystems: {
        cronHealth: SubsystemStatus
        failureDetection: SubsystemStatus
        dataIntegrity: SubsystemStatus
        performance: SubsystemStatus
        executionLocks: SubsystemStatus
        retryActivity: SubsystemStatus
    }
    metrics: {
        cronTotalRuns: number
        cronErrorRuns: number
        cronErrorRate: number
        slowOperations: number
        integrityIssues: number
        criticalIntegrityIssues: number
        activeLocks: number
        avgLatencyMs: number
    }
    previousPeriod: {
        cronErrorRate: number
        slowOperations: number
        integrityIssues: number
        avgLatencyMs: number
    } | null
}

export interface SubsystemStatus {
    status: StabilityStatus
    detail: string
}

let logTableEnsured = false

async function ensureLogTable(): Promise<void> {
    if (logTableEnsured) return
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS stability_check_log (
                id SERIAL PRIMARY KEY,
                scope TEXT NOT NULL,
                status TEXT NOT NULL,
                checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                anomaly_count INT NOT NULL DEFAULT 0,
                report JSONB
            )
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_stability_check_log_time
            ON stability_check_log (checked_at DESC)
        `)
        logTableEnsured = true
    } catch { /* non-blocking */ }
}

/**
 * Run a stability check for the given scope.
 * Returns a structured report and persists it.
 */
export async function runStabilityCheck(scope: CheckScope): Promise<StabilityReport> {
    const windowHours = scope === 'daily' ? 24 : scope === 'weekly' ? 168 : 720
    const anomalies: StabilityAnomaly[] = []
    const now = new Date()

    // ── Collect current period data ─────────────────────────────
    const [cronSummary, failures, slowOps, perfSummary, activeLocks] = await Promise.all([
        getCronHealthSummary(windowHours).catch(() => []),
        detectFailures().catch(() => ({ overallStatus: 'unknown' as AlertStatus, operations: [], checkedAt: now, windowHours: 24 })),
        getSlowOperations(100, windowHours).catch(() => []),
        getPerfSummary(windowHours).catch(() => []),
        getActiveLocks().catch(() => []),
    ])

    // Integrity: run a fresh check for daily, use history for weekly/monthly
    let integrityIssues = 0
    let criticalIntegrityIssues = 0
    if (scope === 'daily') {
        try {
            const report = await IntegrityChecker.runAll()
            integrityIssues = report.issues.length
            criticalIntegrityIssues = report.issues.filter(i => i.severity === 'critical').length
        } catch { /* non-blocking */ }
    } else {
        try {
            const history = await IntegrityChecker.getRecentReports(scope === 'weekly' ? 7 : 30)
            for (const r of history) {
                integrityIssues += r.totalIssues
                criticalIntegrityIssues += r.criticalIssues
            }
        } catch { /* non-blocking */ }
    }

    // ── Compute metrics ─────────────────────────────────────────
    const cronTotalRuns = cronSummary.reduce((s, c) => s + c.totalRuns, 0)
    const cronErrorRuns = cronSummary.reduce((s, c) => s + c.errorRuns, 0)
    const cronErrorRate = cronTotalRuns > 0 ? Math.round((cronErrorRuns / cronTotalRuns) * 1000) / 10 : 0
    const slowOperationCount = slowOps.length
    const avgLatencyMs = perfSummary.length > 0
        ? Math.round(perfSummary.reduce((s, p) => s + p.avgDurationMs, 0) / perfSummary.length)
        : 0

    // ── Load previous period for comparison ─────────────────────
    let previousPeriod: StabilityReport['previousPeriod'] = null
    try {
        await ensureLogTable()
        const prev = await prisma.$queryRawUnsafe<Array<{ report: any }>>(
            `SELECT report FROM stability_check_log
             WHERE scope = $1 AND checked_at < $2
             ORDER BY checked_at DESC LIMIT 1`,
            scope,
            now
        )
        if (prev.length > 0 && prev[0].report?.metrics) {
            const pm = prev[0].report.metrics
            previousPeriod = {
                cronErrorRate: pm.cronErrorRate ?? 0,
                slowOperations: pm.slowOperations ?? 0,
                integrityIssues: pm.integrityIssues ?? 0,
                avgLatencyMs: pm.avgLatencyMs ?? 0,
            }
        }
    } catch { /* non-blocking */ }

    // ── Evaluate subsystems ─────────────────────────────────────
    // Cron health
    const cronStatus: SubsystemStatus = (() => {
        if (cronTotalRuns === 0) return { status: 'unknown' as const, detail: 'Нет данных за период' }
        if (cronErrorRate > 10) {
            anomalies.push({ subsystem: 'cron', severity: 'critical', description: `Частота ошибок cron: ${cronErrorRate}%` })
            return { status: 'critical' as const, detail: `${cronErrorRate}% ошибок (${cronErrorRuns}/${cronTotalRuns})` }
        }
        if (cronErrorRate > 2) {
            anomalies.push({ subsystem: 'cron', severity: 'warning', description: `Повышенная частота ошибок cron: ${cronErrorRate}%` })
            return { status: 'warning' as const, detail: `${cronErrorRate}% ошибок` }
        }
        return { status: 'stable' as const, detail: `${cronTotalRuns} запусков, ${cronErrorRate}% ошибок` }
    })()

    // Failure detection
    const failureStatus: SubsystemStatus = (() => {
        const failMap: Record<string, StabilityStatus> = { normal: 'stable', warning: 'warning', critical: 'critical', unknown: 'unknown', stale: 'warning' }
        const st = failMap[failures.overallStatus] ?? 'unknown'
        const critOps = failures.operations.filter(o => o.status === 'critical')
        if (critOps.length > 0) {
            anomalies.push({ subsystem: 'failures', severity: 'critical', description: `Критичные операции: ${critOps.map(o => o.operationName).join(', ')}` })
        }
        return { status: st, detail: `${failures.operations.length} операций, статус: ${failures.overallStatus}` }
    })()

    // Data integrity
    const integrityStatus: SubsystemStatus = (() => {
        if (criticalIntegrityIssues > 0) {
            anomalies.push({ subsystem: 'integrity', severity: 'critical', description: `${criticalIntegrityIssues} критичных нарушений целостности` })
            return { status: 'critical' as const, detail: `${integrityIssues} проблем (${criticalIntegrityIssues} крит.)` }
        }
        if (integrityIssues > 0) {
            return { status: 'warning' as const, detail: `${integrityIssues} мелких проблем` }
        }
        return { status: 'stable' as const, detail: 'Нарушений не обнаружено' }
    })()

    // Performance
    const perfStatus: SubsystemStatus = (() => {
        if (perfSummary.length === 0) return { status: 'unknown' as const, detail: 'Нет данных' }
        if (slowOperationCount > 10) {
            anomalies.push({ subsystem: 'performance', severity: 'warning', description: `${slowOperationCount} медленных операций` })
            return { status: 'warning' as const, detail: `${slowOperationCount} медленных, среднее ${avgLatencyMs}мс` }
        }
        // Check for degradation vs previous period
        if (previousPeriod && avgLatencyMs > 0 && previousPeriod.avgLatencyMs > 0) {
            const increase = ((avgLatencyMs - previousPeriod.avgLatencyMs) / previousPeriod.avgLatencyMs) * 100
            if (increase > 50) {
                anomalies.push({ subsystem: 'performance', severity: 'warning', description: `Латентность выросла на ${Math.round(increase)}%` })
                return { status: 'warning' as const, detail: `Среднее ${avgLatencyMs}мс (+${Math.round(increase)}%)` }
            }
        }
        return { status: 'stable' as const, detail: `Среднее ${avgLatencyMs}мс, ${slowOperationCount} медленных` }
    })()

    // Execution locks
    const lockStatus: SubsystemStatus = (() => {
        if (activeLocks.length === 0) return { status: 'stable' as const, detail: 'Нет активных блокировок' }
        if (activeLocks.length > 3) {
            anomalies.push({ subsystem: 'locks', severity: 'warning', description: `${activeLocks.length} активных блокировок` })
            return { status: 'warning' as const, detail: `${activeLocks.length} активных блокировок` }
        }
        return { status: 'stable' as const, detail: `${activeLocks.length} активных` }
    })()

    // Retry activity (derived from cron skipped runs)
    const retryStatus: SubsystemStatus = (() => {
        const skippedRuns = cronSummary.reduce((s, c) => s + c.skippedRuns, 0)
        if (skippedRuns > cronTotalRuns * 0.1 && cronTotalRuns > 10) {
            anomalies.push({ subsystem: 'retry', severity: 'warning', description: `${skippedRuns} пропущенных (overlap) запусков` })
            return { status: 'warning' as const, detail: `${skippedRuns} пропусков из ${cronTotalRuns}` }
        }
        return { status: 'stable' as const, detail: `${skippedRuns} пропусков (overlap guard)` }
    })()

    // ── Overall status ──────────────────────────────────────────
    let status: StabilityStatus = 'stable'
    if (anomalies.some(a => a.severity === 'critical')) status = 'critical'
    else if (anomalies.length > 0) status = 'warning'

    const allUnknown = [cronStatus, failureStatus, integrityStatus, perfStatus, lockStatus, retryStatus]
        .every(s => s.status === 'unknown')
    if (allUnknown) status = 'unknown'

    const report: StabilityReport = {
        scope,
        status,
        timestamp: now.toISOString(),
        anomalies,
        subsystems: {
            cronHealth: cronStatus,
            failureDetection: failureStatus,
            dataIntegrity: integrityStatus,
            performance: perfStatus,
            executionLocks: lockStatus,
            retryActivity: retryStatus,
        },
        metrics: {
            cronTotalRuns,
            cronErrorRuns,
            cronErrorRate,
            slowOperations: slowOperationCount,
            integrityIssues,
            criticalIntegrityIssues,
            activeLocks: activeLocks.length,
            avgLatencyMs,
        },
        previousPeriod,
    }

    // ── Persist report ──────────────────────────────────────────
    try {
        await ensureLogTable()
        await prisma.$executeRawUnsafe(
            `INSERT INTO stability_check_log (scope, status, checked_at, anomaly_count, report)
             VALUES ($1, $2, NOW(), $3, $4::jsonb)`,
            scope,
            status,
            anomalies.length,
            JSON.stringify(report)
        )
    } catch { /* non-blocking */ }

    return report
}

/**
 * Get recent stability check reports (for dashboard history).
 */
export async function getRecentStabilityReports(
    limit: number = 10
): Promise<StabilityReportSummary[]> {
    try {
        await ensureLogTable()
        return await prisma.$queryRawUnsafe<StabilityReportSummary[]>(
            `SELECT id, scope, status, checked_at as "checkedAt", anomaly_count as "anomalyCount"
             FROM stability_check_log
             ORDER BY checked_at DESC
             LIMIT $1`,
            limit
        )
    } catch {
        return []
    }
}

export interface StabilityReportSummary {
    id: number
    scope: string
    status: string
    checkedAt: Date
    anomalyCount: number
}
