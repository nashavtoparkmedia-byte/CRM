/**
 * Composition root for compensation budget-period provisioning.
 *
 * One owner operation, reached by operators through the CLI and by nothing
 * else. It opens the month a period key names, or raises its limit, and refuses
 * anything that would lower a limit or reopen a closed month.
 */

import {
    ensureCompensationBudgetPeriodV1 as ensureBudgetPeriod,
    type CompensationBudgetPeriodResultV1,
    type EnsureCompensationBudgetPeriodInputV1,
} from '../internal/compensation/compensation-budget-period-service'
import { legacyPrismaCompensationBudgetPeriodStoreV1 } from '../internal/compensation/legacy-prisma-compensation-budget-period-adapter'

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
