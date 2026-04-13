/**
 * Failure Detection and Alerting — aggregates operational failures into signals.
 *
 * Derives alert status from cron_health_log.
 * Pure read-only aggregation — no new write operations.
 * Thresholds are configurable per operation type.
 */

import { prisma } from '@/lib/prisma'

export const FAILURE_DETECTION_CONFIG = {
    /** Time window for failure counting (hours) */
    windowHours: 24,
    /** Consecutive errors threshold for warning */
    warningConsecutiveErrors: 2,
    /** Consecutive errors threshold for critical */
    criticalConsecutiveErrors: 5,
    /** Error rate % threshold for warning (within window) */
    warningErrorRatePct: 20,
    /** Error rate % threshold for critical (within window) */
    criticalErrorRatePct: 50,
    /** Maximum hours since last successful execution before stale warning */
    staleWarningHours: 2,
    /** Maximum hours since last successful execution before stale critical */
    staleCriticalHours: 6,
}

export type AlertStatus = 'normal' | 'warning' | 'critical' | 'stale' | 'unknown'

export interface OperationAlertState {
    operationName: string
    status: AlertStatus
    reasons: string[]
    totalRuns: number
    errorRuns: number
    errorRatePct: number
    consecutiveErrors: number
    lastSuccessAt: Date | null
    lastErrorAt: Date | null
    lastErrorMessage: string | null
    hoursSinceSuccess: number | null
}

export interface FailureDetectionResult {
    overallStatus: AlertStatus
    operations: OperationAlertState[]
    checkedAt: Date
    windowHours: number
}

/**
 * Detect operational failures across all cron jobs.
 * Reads from cron_health_log, produces aggregated alert states.
 * Fail-safe — returns empty result on error.
 */
export async function detectFailures(): Promise<FailureDetectionResult> {
    const cfg = FAILURE_DETECTION_CONFIG
    const now = new Date()

    try {
        // Get summary per operation within window
        const summaries = await prisma.$queryRawUnsafe<Array<{
            cronName: string
            totalRuns: number
            errorRuns: number
            lastSuccessAt: Date | null
            lastErrorAt: Date | null
            lastErrorMessage: string | null
        }>>(
            `SELECT
                cron_name as "cronName",
                COUNT(*)::int as "totalRuns",
                COUNT(*) FILTER (WHERE status = 'error')::int as "errorRuns",
                MAX(CASE WHEN status = 'ok' THEN executed_at END) as "lastSuccessAt",
                MAX(CASE WHEN status = 'error' THEN executed_at END) as "lastErrorAt",
                MAX(CASE WHEN status = 'error' THEN error_message END) as "lastErrorMessage"
             FROM cron_health_log
             WHERE executed_at > NOW() - INTERVAL '1 hour' * $1
             GROUP BY cron_name
             ORDER BY cron_name`,
            cfg.windowHours
        )

        // Get consecutive error counts (most recent N entries per operation)
        const consecutiveMap = new Map<string, number>()
        for (const s of summaries) {
            const recent = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
                `SELECT status FROM cron_health_log
                 WHERE cron_name = $1
                 ORDER BY executed_at DESC
                 LIMIT 10`,
                s.cronName
            )
            let consecutive = 0
            for (const r of recent) {
                if (r.status === 'error') consecutive++
                else break
            }
            consecutiveMap.set(s.cronName, consecutive)
        }

        const operations: OperationAlertState[] = summaries.map(s => {
            const consecutiveErrors = consecutiveMap.get(s.cronName) ?? 0
            const errorRatePct = s.totalRuns > 0
                ? Math.round((s.errorRuns / s.totalRuns) * 100)
                : 0

            const hoursSinceSuccess = s.lastSuccessAt
                ? Math.round((now.getTime() - new Date(s.lastSuccessAt).getTime()) / (60 * 60 * 1000) * 10) / 10
                : null

            const reasons: string[] = []
            let severity = 0 // 0=normal, 1=warning, 2=critical

            // Check consecutive errors
            if (consecutiveErrors >= cfg.criticalConsecutiveErrors) {
                severity = 2
                reasons.push(`${consecutiveErrors} ошибок подряд`)
            } else if (consecutiveErrors >= cfg.warningConsecutiveErrors) {
                severity = Math.max(severity, 1)
                reasons.push(`${consecutiveErrors} ошибки подряд`)
            }

            // Check error rate
            if (errorRatePct >= cfg.criticalErrorRatePct) {
                severity = 2
                reasons.push(`${errorRatePct}% ошибок`)
            } else if (errorRatePct >= cfg.warningErrorRatePct) {
                severity = Math.max(severity, 1)
                reasons.push(`${errorRatePct}% ошибок`)
            }

            // Check staleness
            if (hoursSinceSuccess !== null) {
                if (hoursSinceSuccess >= cfg.staleCriticalHours) {
                    severity = 2
                    reasons.push(`Нет успешных ${Math.round(hoursSinceSuccess)}ч`)
                } else if (hoursSinceSuccess >= cfg.staleWarningHours) {
                    severity = Math.max(severity, 1)
                    reasons.push(`Нет успешных ${Math.round(hoursSinceSuccess)}ч`)
                }
            } else if (s.totalRuns > 0) {
                severity = 2
                reasons.push('Нет успешных запусков')
            }

            const status: AlertStatus = severity === 2 ? 'critical' : severity === 1 ? 'warning' : 'normal'

            return {
                operationName: s.cronName,
                status,
                reasons,
                totalRuns: s.totalRuns,
                errorRuns: s.errorRuns,
                errorRatePct,
                consecutiveErrors,
                lastSuccessAt: s.lastSuccessAt,
                lastErrorAt: s.lastErrorAt,
                lastErrorMessage: s.lastErrorMessage,
                hoursSinceSuccess,
            }
        })

        // Overall status = worst status across operations
        let overallStatus: AlertStatus = 'normal'
        if (operations.length === 0) {
            overallStatus = 'unknown'
        } else {
            let maxSeverity = 0
            for (const op of operations) {
                if (op.status === 'critical') maxSeverity = 2
                else if (op.status === 'warning' && maxSeverity < 2) maxSeverity = 1
            }
            overallStatus = maxSeverity === 2 ? 'critical' : maxSeverity === 1 ? 'warning' : 'normal'
        }

        return { overallStatus, operations, checkedAt: now, windowHours: cfg.windowHours }
    } catch {
        return { overallStatus: 'unknown', operations: [], checkedAt: now, windowHours: cfg.windowHours }
    }
}
