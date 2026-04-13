/**
 * Configuration Change Validation & Audit — Change Safety Guardrails.
 *
 * Tasks 1, 3, 4: Validates all operational configs at startup,
 * logs threshold changes, verifies cron schedule validity.
 *
 * Deterministic, non-blocking, transparent.
 * Invalid config detected at startup — logged as critical, but does not
 * crash the server (graceful degradation with defaults).
 */

import { prisma } from '@/lib/prisma'
import { opsLog } from '@/lib/opsLog'

// ─── Config Registry ────────────────────────────────────────────────

interface ConfigRule {
    name: string
    value: () => unknown
    validate: (v: unknown) => string | null  // returns error string or null if valid
}

const rules: ConfigRule[] = []

/**
 * Register a config value with a validation rule.
 * Called at module load time by config files or by the validator itself.
 */
export function registerConfigRule(rule: ConfigRule): void {
    rules.push(rule)
}

// ─── Built-in Validators ────────────────────────────────────────────

function positiveInt(name: string, getValue: () => number): ConfigRule {
    return {
        name,
        value: getValue,
        validate: (v) => {
            const n = v as number
            if (typeof n !== 'number' || !Number.isFinite(n)) return `${name}: не число`
            if (n <= 0) return `${name}: должно быть > 0 (получено: ${n})`
            if (!Number.isInteger(n)) return `${name}: должно быть целым (получено: ${n})`
            return null
        },
    }
}

function nonNegativeNum(name: string, getValue: () => number): ConfigRule {
    return {
        name,
        value: getValue,
        validate: (v) => {
            const n = v as number
            if (typeof n !== 'number' || !Number.isFinite(n)) return `${name}: не число`
            if (n < 0) return `${name}: должно быть >= 0 (получено: ${n})`
            return null
        },
    }
}

function rangeInt(name: string, getValue: () => number, min: number, max: number): ConfigRule {
    return {
        name,
        value: getValue,
        validate: (v) => {
            const n = v as number
            if (typeof n !== 'number' || !Number.isFinite(n)) return `${name}: не число`
            if (n < min || n > max) return `${name}: вне диапазона [${min}, ${max}] (получено: ${n})`
            return null
        },
    }
}

// ─── Task 1: Register All Operational Configs ───────────────────────

export function registerAllConfigs(): void {
    // Lazy imports to avoid circular dependencies
    try {
        const { COMPLETION_THRESHOLDS } = require('@/lib/tasks/completion-config')
        registerConfigRule(positiveInt('completion.minCompletionMinutes', () => COMPLETION_THRESHOLDS.minCompletionMinutes))
    } catch { /* module may not exist */ }

    try {
        const { RESPONSE_THRESHOLDS } = require('@/lib/tasks/response-config')
        registerConfigRule(positiveInt('response.maxResponseMinutes', () => RESPONSE_THRESHOLDS.maxResponseMinutes))
    } catch { /* module may not exist */ }

    try {
        const { RISK_THRESHOLDS } = require('@/lib/tasks/risk-config')
        registerConfigRule(positiveInt('risk.highRiskAttempts', () => RISK_THRESHOLDS.highRiskAttempts))
        registerConfigRule(positiveInt('risk.slaWarningMinutes', () => RISK_THRESHOLDS.slaWarningMinutes))
    } catch { /* module may not exist */ }

    try {
        const { WORKLOAD_THRESHOLDS } = require('@/lib/tasks/workload-config')
        registerConfigRule(positiveInt('workload.maxActiveTasks', () => WORKLOAD_THRESHOLDS.maxActiveTasks))
        registerConfigRule(positiveInt('workload.maxOverdueTasks', () => WORKLOAD_THRESHOLDS.maxOverdueTasks))
    } catch { /* module may not exist */ }

    try {
        const { PATTERN_THRESHOLDS } = require('@/lib/tasks/pattern-config')
        registerConfigRule(positiveInt('pattern.warningThreshold', () => PATTERN_THRESHOLDS.warningThreshold))
        registerConfigRule(positiveInt('pattern.patternThreshold', () => PATTERN_THRESHOLDS.patternThreshold))
    } catch { /* module may not exist */ }

    try {
        const { INTERVENTION_OUTCOME_CONFIG, EFFECTIVENESS_THRESHOLDS } = require('@/lib/tasks/intervention-outcome-config')
        registerConfigRule(positiveInt('outcome.outcomeWindowHours', () => INTERVENTION_OUTCOME_CONFIG.outcomeWindowHours))
        registerConfigRule(rangeInt('effectiveness.good', () => EFFECTIVENESS_THRESHOLDS.good, 1, 100))
        registerConfigRule(rangeInt('effectiveness.moderate', () => EFFECTIVENESS_THRESHOLDS.moderate, 1, 100))
    } catch { /* module may not exist */ }

    try {
        const { CAPACITY_CONFIG } = require('@/lib/tasks/capacity-config')
        registerConfigRule(positiveInt('capacity.highPressureThreshold', () => CAPACITY_CONFIG.highPressureThreshold))
        registerConfigRule(nonNegativeNum('capacity.lowUtilizationThreshold', () => CAPACITY_CONFIG.lowUtilizationThreshold))
    } catch { /* module may not exist */ }

    try {
        const { RELIABILITY_CONFIG } = require('@/lib/tasks/reliability-config')
        registerConfigRule(rangeInt('reliability.reliableThresholdPct', () => RELIABILITY_CONFIG.reliableThresholdPct, 1, 100))
        registerConfigRule(rangeInt('reliability.pressuredThresholdPct', () => RELIABILITY_CONFIG.pressuredThresholdPct, 1, 100))
    } catch { /* module may not exist */ }

    try {
        const { INTERVENTION_AGING_CONFIG } = require('@/lib/tasks/intervention-aging-config')
        registerConfigRule(positiveInt('aging.pendingActionAgingHours', () => INTERVENTION_AGING_CONFIG.pendingActionAgingHours))
        registerConfigRule(positiveInt('aging.pendingOutcomeAgingHours', () => INTERVENTION_AGING_CONFIG.pendingOutcomeAgingHours))
    } catch { /* module may not exist */ }

    try {
        const { VOLATILITY_CONFIG } = require('@/lib/tasks/volatility-config')
        registerConfigRule(positiveInt('volatility.minPointsPerManager', () => VOLATILITY_CONFIG.minPointsPerManager))
        registerConfigRule(nonNegativeNum('volatility.calmMaxCv', () => VOLATILITY_CONFIG.calmMaxCv))
        registerConfigRule(positiveInt('volatility.volatileMinCv', () => VOLATILITY_CONFIG.volatileMinCv))
    } catch { /* module may not exist */ }

    try {
        const { FAILURE_DETECTION_CONFIG } = require('@/lib/failure-detection')
        registerConfigRule(positiveInt('failureDetection.windowHours', () => FAILURE_DETECTION_CONFIG.windowHours))
        registerConfigRule(positiveInt('failureDetection.criticalConsecutiveErrors', () => FAILURE_DETECTION_CONFIG.criticalConsecutiveErrors))
        registerConfigRule(rangeInt('failureDetection.criticalErrorRatePct', () => FAILURE_DETECTION_CONFIG.criticalErrorRatePct, 1, 100))
    } catch { /* module may not exist */ }

    try {
        const { PERF_CONFIG } = require('@/lib/perf-monitor')
        registerConfigRule(positiveInt('perf.defaultSlowThresholdMs', () => PERF_CONFIG.defaultSlowThresholdMs))
        registerConfigRule(positiveInt('perf.cronSlowThresholdMs', () => PERF_CONFIG.cronSlowThresholdMs))
        registerConfigRule(positiveInt('perf.apiSlowThresholdMs', () => PERF_CONFIG.apiSlowThresholdMs))
        registerConfigRule(positiveInt('perf.querySlowThresholdMs', () => PERF_CONFIG.querySlowThresholdMs))
        registerConfigRule(positiveInt('perf.retentionDays', () => PERF_CONFIG.retentionDays))
    } catch { /* module may not exist */ }

    try {
        const cfg = require('@/lib/tasks/manager-health-config')
        registerConfigRule(positiveInt('health.warningThreshold', () => cfg.HEALTH_SCORE_CONFIG.warningThreshold))
        registerConfigRule(positiveInt('health.criticalThreshold', () => cfg.HEALTH_SCORE_CONFIG.criticalThreshold))
        registerConfigRule(positiveInt('stability.minDataPoints', () => cfg.STABILITY_CONFIG.minDataPoints))
        registerConfigRule(positiveInt('riskPersistence.sustainedRiskHours', () => cfg.RISK_PERSISTENCE_CONFIG.sustainedRiskHours))
    } catch { /* module may not exist */ }
}

// ─── Task 1: Validate All ───────────────────────────────────────────

export interface ConfigValidationResult {
    valid: boolean
    errors: string[]
    checkedRules: number
    timestamp: string
}

/**
 * Validate all registered config rules.
 * Returns validation result. Never throws.
 */
export function validateAllConfigs(): ConfigValidationResult {
    if (rules.length === 0) registerAllConfigs()

    const errors: string[] = []

    for (const rule of rules) {
        try {
            const value = rule.value()
            const error = rule.validate(value)
            if (error) errors.push(error)
        } catch (e: any) {
            errors.push(`${rule.name}: ошибка при чтении — ${e.message}`)
        }
    }

    const result: ConfigValidationResult = {
        valid: errors.length === 0,
        errors,
        checkedRules: rules.length,
        timestamp: new Date().toISOString(),
    }

    if (!result.valid) {
        opsLog('error', 'config_validation_failed', {
            operation: 'config_validator',
            count: errors.length,
            error: errors.join('; '),
        })
    } else {
        opsLog('info', 'config_validation_passed', {
            operation: 'config_validator',
            count: rules.length,
        })
    }

    return result
}

// ─── Task 3: Threshold Change Audit ─────────────────────────────────

let auditTableEnsured = false

async function ensureAuditTable(): Promise<void> {
    if (auditTableEnsured) return
    try {
        await prisma.$executeRawUnsafe(`
            CREATE TABLE IF NOT EXISTS config_change_log (
                id SERIAL PRIMARY KEY,
                parameter_name TEXT NOT NULL,
                previous_value TEXT,
                new_value TEXT NOT NULL,
                changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                changed_by TEXT
            )
        `)
        await prisma.$executeRawUnsafe(`
            CREATE INDEX IF NOT EXISTS idx_config_change_log_time
            ON config_change_log (changed_at DESC)
        `)
        auditTableEnsured = true
    } catch { /* non-blocking */ }
}

/**
 * Record a configuration change. Fail-safe.
 */
export async function logConfigChange(entry: {
    parameterName: string
    previousValue: string | null
    newValue: string
    changedBy?: string
}): Promise<void> {
    try {
        await ensureAuditTable()
        await prisma.$executeRawUnsafe(
            `INSERT INTO config_change_log (parameter_name, previous_value, new_value, changed_at, changed_by)
             VALUES ($1, $2, $3, NOW(), $4)`,
            entry.parameterName,
            entry.previousValue ?? null,
            entry.newValue,
            entry.changedBy ?? null
        )
        opsLog('info', 'config_changed', {
            operation: entry.parameterName,
        })
    } catch { /* non-blocking */ }
}

/**
 * Get recent config changes (for dashboard).
 */
export async function getRecentConfigChanges(limit: number = 20): Promise<ConfigChangeEntry[]> {
    try {
        await ensureAuditTable()
        return await prisma.$queryRawUnsafe<ConfigChangeEntry[]>(
            `SELECT id, parameter_name as "parameterName", previous_value as "previousValue",
                    new_value as "newValue", changed_at as "changedAt", changed_by as "changedBy"
             FROM config_change_log
             ORDER BY changed_at DESC
             LIMIT $1`,
            limit
        )
    } catch {
        return []
    }
}

export interface ConfigChangeEntry {
    id: number
    parameterName: string
    previousValue: string | null
    newValue: string
    changedAt: Date
    changedBy: string | null
}

// ─── Task 4: Cron Schedule Verification ─────────────────────────────

export interface CronScheduleEntry {
    name: string
    intervalMs: number
    source: 'instrumentation' | 'api_cron'
}

/**
 * Known cron schedules. Updated when new jobs are added.
 */
export const KNOWN_CRON_SCHEDULES: CronScheduleEntry[] = [
    { name: 'recovery', intervalMs: 5 * 60 * 1000, source: 'instrumentation' },
    { name: 'integrity', intervalMs: 30 * 60 * 1000, source: 'instrumentation' },
    { name: 'message_retry', intervalMs: 2 * 60 * 1000, source: 'instrumentation' },
    { name: 'wa_watchdog', intervalMs: 60 * 1000, source: 'instrumentation' },
    { name: 'retention_cleanup', intervalMs: 24 * 60 * 60 * 1000, source: 'instrumentation' },
    { name: 'stability_check', intervalMs: 24 * 60 * 60 * 1000, source: 'instrumentation' },
    { name: 'auto-close-tasks', intervalMs: 0, source: 'api_cron' },
    { name: 'enforce-followup', intervalMs: 0, source: 'api_cron' },
    { name: 'escalations', intervalMs: 0, source: 'api_cron' },
    { name: 'init-telegram', intervalMs: 0, source: 'api_cron' },
    { name: 'pattern-alerts', intervalMs: 0, source: 'api_cron' },
    { name: 'sla-escalation', intervalMs: 0, source: 'api_cron' },
    { name: 'sync-scraper', intervalMs: 0, source: 'api_cron' },
    { name: 'sync-trips', intervalMs: 0, source: 'api_cron' },
    { name: 'stability-check', intervalMs: 0, source: 'api_cron' },
]

export interface CronScheduleValidation {
    valid: boolean
    errors: string[]
    schedules: number
}

/**
 * Validate cron schedule consistency.
 */
export function validateCronSchedules(): CronScheduleValidation {
    const errors: string[] = []
    const names = new Set<string>()

    for (const sched of KNOWN_CRON_SCHEDULES) {
        // Duplicate name check
        if (names.has(sched.name)) {
            errors.push(`Дублирующееся имя cron: ${sched.name}`)
        }
        names.add(sched.name)

        // Interval validation for instrumentation jobs
        if (sched.source === 'instrumentation' && sched.intervalMs > 0) {
            if (sched.intervalMs < 10_000) {
                errors.push(`${sched.name}: интервал слишком мал (${sched.intervalMs}ms < 10s)`)
            }
            if (sched.intervalMs > 7 * 24 * 60 * 60 * 1000) {
                errors.push(`${sched.name}: интервал слишком велик (> 7 дней)`)
            }
        }
    }

    return { valid: errors.length === 0, errors, schedules: KNOWN_CRON_SCHEDULES.length }
}
