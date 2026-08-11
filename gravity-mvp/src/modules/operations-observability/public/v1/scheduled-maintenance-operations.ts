import { IntegrityChecker } from '@/lib/IntegrityChecker'
import { RetentionCleanup } from '@/lib/RetentionCleanup'
import { runStabilityCheck } from '@/lib/stability-check'

/** Run the complete read-only integrity plan and persist its report. */
export async function runOperationalIntegrityCheckV1() {
    return IntegrityChecker.runAll()
}

/** Run the fixed retention plan, honoring the deployment dry-run switch. */
export async function runScheduledRetentionCleanupV1() {
    return RetentionCleanup.runAll(process.env.RETENTION_DRY_RUN === 'true')
}

/** Run the daily stability scope used by the application scheduler. */
export async function runDailyOperationalStabilityCheckV1() {
    return runStabilityCheck('daily')
}
