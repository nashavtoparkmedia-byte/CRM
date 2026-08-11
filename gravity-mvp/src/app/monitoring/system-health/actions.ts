'use server'

import { getCronHealthSummary, type CronHealthSummaryEntry } from '@/lib/cron-health'
import { detectFailures, type FailureDetectionResult } from '@/lib/failure-detection'
import { IntegrityChecker, type IntegrityReportSummary } from '@/lib/IntegrityChecker'
import { getSlowOperations, getPerfSummary, type SlowOperationEntry, type PerfSummaryEntry } from '@/lib/perf-monitor'
import { getActiveLocks, type ActiveLock } from '@/lib/execution-lock'
import { getRecentStabilityReports, type StabilityReportSummary } from '@/lib/stability-check'
import {
    listRecentConfigurationChangesV1,
    validateOperationalConfigurationV1,
    validateOperationalCronSchedulesV1,
    type ConfigurationChangeEntryV1,
    type OperationalConfigurationValidationV1,
    type OperationalCronScheduleValidationV1,
} from '@/modules/configuration/public/v1/operational-configuration-health'
import { checkRuntimeGuardrails, type GuardrailCheckResult } from '@/lib/runtime-guardrails'
import { OperationalJobs } from '@/lib/OperationalJobs'

export interface SystemHealthData {
    cronSummary: CronHealthSummaryEntry[]
    failureDetection: FailureDetectionResult
    integrityReports: IntegrityReportSummary[]
    slowOperations: SlowOperationEntry[]
    perfSummary: PerfSummaryEntry[]
    activeLocks: ActiveLock[]
    stabilityReports: StabilityReportSummary[]
    configValidation: OperationalConfigurationValidationV1
    cronValidation: OperationalCronScheduleValidationV1
    runtimeGuardrails: GuardrailCheckResult
    recentConfigChanges: ConfigurationChangeEntryV1[]
    backgroundJobs: Record<string, {
        isRunning: boolean
        lastRunAt: string | null
        lastCompletedAt: string | null
        lastError: string | null
    }>
    fetchedAt: string
}

export async function getSystemHealthData(): Promise<SystemHealthData> {
    // Parallel fetch for all health signals
    const [
        cronSummary,
        failureDetection,
        integrityReports,
        slowOperations,
        perfSummary,
        activeLocks,
        stabilityReports,
    ] = await Promise.all([
        getCronHealthSummary(24).catch(() => [] as CronHealthSummaryEntry[]),
        detectFailures().catch(() => ({
            overallStatus: 'unknown' as const,
            operations: [],
            checkedAt: new Date(),
            windowHours: 24,
        })),
        IntegrityChecker.getRecentReports(5).catch(() => [] as IntegrityReportSummary[]),
        getSlowOperations(10, 24).catch(() => [] as SlowOperationEntry[]),
        getPerfSummary(24).catch(() => [] as PerfSummaryEntry[]),
        getActiveLocks().catch(() => [] as ActiveLock[]),
        getRecentStabilityReports(5).catch(() => [] as StabilityReportSummary[]),
    ])

    // Config validation (synchronous)
    const configValidation = validateOperationalConfigurationV1()
    const cronValidation = validateOperationalCronSchedulesV1()

    // Runtime guardrails + config changes (async)
    const [runtimeGuardrails, recentConfigChanges] = await Promise.all([
        checkRuntimeGuardrails().catch(() => ({ status: 'ok' as const, violations: [], checkedAt: new Date().toISOString() })),
        listRecentConfigurationChangesV1(5).catch(() => [] as ConfigurationChangeEntryV1[]),
    ])

    // Background jobs state (in-memory, synchronous)
    const rawJobs = OperationalJobs.getAllJobStates()
    const backgroundJobs: SystemHealthData['backgroundJobs'] = {}
    for (const [name, state] of Object.entries(rawJobs)) {
        backgroundJobs[name] = {
            isRunning: state.isRunning,
            lastRunAt: state.lastRunAt?.toISOString() ?? null,
            lastCompletedAt: state.lastCompletedAt?.toISOString() ?? null,
            lastError: state.lastError,
        }
    }

    return {
        cronSummary,
        failureDetection,
        integrityReports,
        slowOperations,
        perfSummary,
        activeLocks,
        stabilityReports,
        configValidation,
        cronValidation,
        runtimeGuardrails,
        recentConfigChanges,
        backgroundJobs,
        fetchedAt: new Date().toISOString(),
    }
}
