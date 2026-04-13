/**
 * Runtime Guardrails — detects unsafe runtime conditions.
 *
 * Task 5: Monitors for repeated failures, excessive retries,
 * sustained performance degradation, and lock backlogs.
 *
 * Deterministic, non-blocking, read-only.
 * Generates alerts but never interrupts operation.
 */

import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'

export const GUARDRAIL_CONFIG = {
    /** Consecutive failures before alert */
    maxConsecutiveFailures: 5,
    /** Max active locks before alert */
    maxActiveLocks: 5,
    /** Slow operations in 1h window before alert */
    maxSlowOpsPerHour: 10,
    /** Error rate % in 1h window before alert */
    maxErrorRatePerHour: 30,
}

export type GuardrailSeverity = 'ok' | 'warning' | 'critical'

export interface GuardrailViolation {
    rule: string
    severity: GuardrailSeverity
    description: string
    value: number
    threshold: number
}

export interface GuardrailCheckResult {
    status: GuardrailSeverity
    violations: GuardrailViolation[]
    checkedAt: string
}

/**
 * Check all runtime guardrails. Pure read-only.
 * Returns list of violations with severity.
 */
export async function checkRuntimeGuardrails(): Promise<GuardrailCheckResult> {
    const violations: GuardrailViolation[] = []
    const cfg = GUARDRAIL_CONFIG

    // ── Consecutive failures per cron ───────────────────────────
    try {
        const crons = await prisma.$queryRawUnsafe<Array<{ cron_name: string }>>(
            `SELECT DISTINCT cron_name FROM cron_health_log`
        )

        for (const { cron_name } of crons) {
            const recent = await prisma.$queryRawUnsafe<Array<{ status: string }>>(
                `SELECT status FROM cron_health_log
                 WHERE cron_name = $1
                 ORDER BY executed_at DESC
                 LIMIT $2`,
                cron_name,
                cfg.maxConsecutiveFailures + 1
            )

            let consecutive = 0
            for (const r of recent) {
                if (r.status === 'error') consecutive++
                else break
            }

            if (consecutive >= cfg.maxConsecutiveFailures) {
                violations.push({
                    rule: 'consecutive_failures',
                    severity: 'critical',
                    description: `${cron_name}: ${consecutive} ошибок подряд`,
                    value: consecutive,
                    threshold: cfg.maxConsecutiveFailures,
                })
            }
        }
    } catch { /* non-blocking */ }

    // ── Error rate per hour ─────────────────────────────────────
    try {
        const hourStats = await prisma.$queryRawUnsafe<Array<{ total: number; errors: number }>>(
            `SELECT COUNT(*)::int as total,
                    COUNT(*) FILTER (WHERE status = 'error')::int as errors
             FROM cron_health_log
             WHERE executed_at > NOW() - INTERVAL '1 hour'`
        )

        if (hourStats.length > 0 && hourStats[0].total > 0) {
            const rate = Math.round((hourStats[0].errors / hourStats[0].total) * 100)
            if (rate >= cfg.maxErrorRatePerHour) {
                violations.push({
                    rule: 'high_error_rate',
                    severity: 'critical',
                    description: `${rate}% ошибок за последний час`,
                    value: rate,
                    threshold: cfg.maxErrorRatePerHour,
                })
            }
        }
    } catch { /* non-blocking */ }

    // ── Active lock backlog ─────────────────────────────────────
    try {
        const locks = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*)::int as cnt FROM execution_lock WHERE expires_at > NOW()`
        )

        const lockCount = locks[0]?.cnt ?? 0
        if (lockCount >= cfg.maxActiveLocks) {
            violations.push({
                rule: 'lock_backlog',
                severity: 'warning',
                description: `${lockCount} активных блокировок`,
                value: lockCount,
                threshold: cfg.maxActiveLocks,
            })
        }
    } catch { /* non-blocking */ }

    // ── Slow operations per hour ────────────────────────────────
    try {
        const slowStats = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*)::int as cnt FROM perf_log
             WHERE is_slow = true AND logged_at > NOW() - INTERVAL '1 hour'`
        )

        const slowCount = slowStats[0]?.cnt ?? 0
        if (slowCount >= cfg.maxSlowOpsPerHour) {
            violations.push({
                rule: 'sustained_slow_ops',
                severity: 'warning',
                description: `${slowCount} медленных операций за час`,
                value: slowCount,
                threshold: cfg.maxSlowOpsPerHour,
            })
        }
    } catch { /* non-blocking */ }

    // ── Stale locks (expired but not cleaned) ───────────────────
    try {
        const stale = await prisma.$queryRawUnsafe<Array<{ cnt: number }>>(
            `SELECT COUNT(*)::int as cnt FROM execution_lock WHERE expires_at <= NOW()`
        )

        const staleCount = stale[0]?.cnt ?? 0
        if (staleCount > 0) {
            violations.push({
                rule: 'stale_locks',
                severity: 'warning',
                description: `${staleCount} просроченных блокировок не очищены`,
                value: staleCount,
                threshold: 0,
            })
        }
    } catch { /* non-blocking */ }

    // ── Determine overall severity ──────────────────────────────
    let status: GuardrailSeverity = 'ok'
    if (violations.some(v => v.severity === 'critical')) status = 'critical'
    else if (violations.length > 0) status = 'warning'

    // Log violations
    if (violations.length > 0) {
        opsLog(status === 'critical' ? 'error' : 'warn', 'guardrail_violations', {
            operation: 'runtime_guardrails',
            count: violations.length,
            error: violations.map(v => v.description).join('; '),
        })
    }

    return {
        status,
        violations,
        checkedAt: new Date().toISOString(),
    }
}
