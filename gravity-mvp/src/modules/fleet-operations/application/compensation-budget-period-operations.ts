/**
 * Composition root for compensation budget-period provisioning.
 *
 * Two owner operations. Operators reach the first through the CLI: it opens the
 * month a period key names, or raises its limit, and refuses anything that
 * would lower a limit or reopen a closed month. The scheduler reaches the
 * second: it opens the current and the next month at the configured limit and
 * never changes a month that is already stored.
 */

import { parseCompensationMonthlyBudgetLimitV1 } from '../internal/compensation/compensation-budget-period'
import {
    ensureCompensationBudgetPeriodV1 as ensureBudgetPeriod,
    provisionCompensationBudgetPeriodsV1,
    type CompensationBudgetPeriodResultV1,
    type CompensationBudgetProvisioningRunV1,
    type EnsureCompensationBudgetPeriodInputV1,
} from '../internal/compensation/compensation-budget-period-service'
import { legacyPrismaCompensationBudgetPeriodStoreV1 } from '../internal/compensation/legacy-prisma-compensation-budget-period-adapter'

// The composition root is also where the operation's vocabulary leaves the
// module: the public facade re-exports these from here, so it never has to
// name an internal path of its own.
export type { CompensationBudgetPeriodResultV1, CompensationBudgetProvisioningRunV1, EnsureCompensationBudgetPeriodInputV1 }
export type {
    CompensationBudgetPeriodOutcomeV1,
    CompensationBudgetPeriodRefusalV1,
    CompensationBudgetPeriodViewV1,
} from '../internal/compensation/compensation-budget-period'

/**
 * Ensures the compensation budget month exists with at least this limit.
 *
 * The answer is assembled here field by field, so what leaves this composition
 * root is a stated result and never a value carrying a persistence handle.
 */
export async function ensureCompensationBudgetPeriodV1(
    input: EnsureCompensationBudgetPeriodInputV1,
): Promise<CompensationBudgetPeriodResultV1> {
    const result = await ensureBudgetPeriod(input, legacyPrismaCompensationBudgetPeriodStoreV1)
    return {
        ok: result.ok,
        dryRun: result.dryRun,
        outcome: result.outcome,
        refusal: result.refusal,
        period: result.period === null ? null : {
            id: result.period.id,
            periodKey: result.period.periodKey,
            periodStartsAt: result.period.periodStartsAt,
            periodEndsAt: result.period.periodEndsAt,
            submissionClosesAt: result.period.submissionClosesAt,
            state: result.period.state,
            limitKopecks: result.period.limitKopecks,
            reservedKopecks: result.period.reservedKopecks,
            settledKopecks: result.period.settledKopecks,
            remainingKopecks: result.period.remainingKopecks,
        },
    }
}

/** The configured limit new months open at, in kopecks; unset opens nothing. */
const MONTHLY_BUDGET_LIMIT_ENV = 'YOKO_CASH_MONTHLY_BUDGET_KOPECKS'

export interface CompensationBudgetProvisioningScheduleV1 {
    firstRunDelayMs: number
    intervalMs: number
}

/**
 * Hourly, and soon after start, so the next month is open long before its
 * first business day and a missed or failed run is made good within the hour.
 */
export function compensationBudgetProvisioningScheduleV1(): CompensationBudgetProvisioningScheduleV1 {
    return { firstRunDelayMs: 2 * 60 * 1000, intervalMs: 60 * 60 * 1000 }
}

/**
 * One scheduled pass: the current and the next business month, create-only.
 *
 * Every month gets one structured line. A month that is missing, refused or
 * failed also names what an operator does about it, and the pass then throws,
 * so the operational job registry records an error in cron health rather than
 * a success.
 */
export async function runScheduledCompensationBudgetProvisioningV1(
    now: Date = new Date(),
): Promise<CompensationBudgetProvisioningRunV1> {
    const limitKopecks = parseCompensationMonthlyBudgetLimitV1(process.env.YOKO_CASH_MONTHLY_BUDGET_KOPECKS)
    const run = await provisionCompensationBudgetPeriodsV1({ now, limitKopecks }, legacyPrismaCompensationBudgetPeriodStoreV1)
    for (const month of run.months) {
        const fields = {
            periodKey: month.periodKey,
            limitKopecks: month.limitKopecks,
            configuredLimitKopecks: run.configuredLimitKopecks,
            state: month.state,
        }
        if (month.status === 'created') {
            console.info(JSON.stringify({ event: 'compensation_budget_period_created', ...fields }))
        } else if (month.status === 'present' && month.limitDiffersFromConfiguration) {
            console.warn(JSON.stringify({
                event: 'compensation_budget_period_limit_differs',
                ...fields,
                action: 'none taken: a stored month is never changed by the scheduler; an operator may raise it with scripts/compensation-budget-period.ts',
            }))
        } else if (month.status === 'missing_unconfigured') {
            console.error(JSON.stringify({
                event: 'compensation_budget_period_missing',
                ...fields,
                action: `set ${MONTHLY_BUDGET_LIMIT_ENV} to the Owner-approved monthly limit, or open the month with scripts/compensation-budget-period.ts`,
            }))
        } else if (month.status === 'refused' || month.status === 'failed') {
            console.error(JSON.stringify({
                event: 'compensation_budget_provisioning_failed',
                ...fields,
                refusal: month.refusal,
                error: month.error,
                action: 'the next hourly run retries; check the month with scripts/compensation-budget-period.ts --dry-run',
            }))
        }
    }
    if (!run.ok) {
        const open = run.months.filter((month) => month.status !== 'created' && month.status !== 'present')
        throw new Error(`compensation budget months not open: ${open.map((month) => `${month.periodKey}=${month.status}`).join(', ')}`)
    }
    return {
        ok: run.ok,
        configuredLimitKopecks: run.configuredLimitKopecks,
        months: run.months.map((month) => ({ ...month })),
    }
}
