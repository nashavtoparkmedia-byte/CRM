/**
 * The provisioning seam: open one compensation budget month, or state why not.
 *
 * Every decision comes from compensation-budget-period; storage is reached
 * through the port, which takes the same decision again under the month's row
 * lock. A dry run reads and plans and writes nothing, so an operator can see
 * the outcome before authorising it.
 *
 * This seam never touches reserved or settled: those counters belong to the
 * monetary core, and provisioning only ever opens a month or raises its limit.
 */

import {
    compensationBudgetPeriodViewV1,
    compensationBudgetPeriodWindowV1,
    planCompensationBudgetPeriodV1,
    type CompensationBudgetPeriodOutcomeV1,
    type CompensationBudgetPeriodRefusalV1,
    type CompensationBudgetPeriodRowV1,
    type CompensationBudgetPeriodViewV1,
    type CompensationBudgetPeriodWindowV1,
} from './compensation-budget-period'

export interface CompensationBudgetPeriodPortV1 {
    /** The stored month, or null when it does not exist yet. */
    findPeriod(periodKey: string): Promise<CompensationBudgetPeriodRowV1 | null>
    /**
     * Opens the month or raises its limit, under the row lock, re-deciding
     * against the row it locked. Returns the month storage holds afterwards.
     */
    provisionPeriod(input: {
        window: CompensationBudgetPeriodWindowV1
        id: string
        limitKopecks: number
    }): Promise<
        | { ok: true; outcome: CompensationBudgetPeriodOutcomeV1; row: CompensationBudgetPeriodRowV1 }
        | { ok: false; refusal: CompensationBudgetPeriodRefusalV1; row: CompensationBudgetPeriodRowV1 | null }
    >
}

export interface EnsureCompensationBudgetPeriodInputV1 {
    periodKey: unknown
    limitKopecks: unknown
    /** Read and plan only: no month is opened and no limit moves. */
    dryRun?: boolean
}

export interface CompensationBudgetPeriodResultV1 {
    ok: boolean
    dryRun: boolean
    /** What happened, or what a real run would do when this was a dry run. */
    outcome: CompensationBudgetPeriodOutcomeV1 | null
    refusal: CompensationBudgetPeriodRefusalV1 | null
    /** The month as storage holds it; null when nothing is stored yet. */
    period: CompensationBudgetPeriodViewV1 | null
}

/**
 * Opens the month the key names, with at least the limit asked for.
 *
 * Creating is idempotent by period key, raising a limit is monotonic, and
 * lowering one or reopening a closed month is refused.
 */
export async function ensureCompensationBudgetPeriodV1(
    input: EnsureCompensationBudgetPeriodInputV1,
    port: CompensationBudgetPeriodPortV1,
): Promise<CompensationBudgetPeriodResultV1> {
    const dryRun = input.dryRun === true
    const window = compensationBudgetPeriodWindowV1(input.periodKey)
    if (window === null) {
        return { ok: false, dryRun, outcome: null, refusal: 'invalid_period_key', period: null }
    }

    const existing = await port.findPeriod(window.periodKey)
    const plan = planCompensationBudgetPeriodV1(
        { periodKey: window.periodKey, limitKopecks: input.limitKopecks },
        existing,
    )
    if ('refusal' in plan) {
        return {
            ok: false,
            dryRun,
            outcome: null,
            refusal: plan.refusal,
            period: existing === null ? null : view(existing, window),
        }
    }

    if (dryRun) {
        return {
            ok: true,
            dryRun: true,
            outcome: plan.action === 'create' ? 'created' : plan.action === 'increase' ? 'limit_increased' : 'already_configured',
            refusal: null,
            period: existing === null ? null : view(existing, window),
        }
    }

    const stored = await port.provisionPeriod({
        window,
        id: plan.action === 'create' ? plan.id : plan.action === 'increase' ? plan.id : existing!.id,
        limitKopecks: plan.action === 'none' ? existing!.limitKopecks : plan.limitKopecks,
    })
    if (!stored.ok) {
        return {
            ok: false,
            dryRun: false,
            outcome: null,
            refusal: stored.refusal,
            period: stored.row === null ? null : view(stored.row, window),
        }
    }
    return { ok: true, dryRun: false, outcome: stored.outcome, refusal: null, period: view(stored.row, window) }
}

/** Stated field by field, so no stored value leaves this seam by reference. */
function view(row: CompensationBudgetPeriodRowV1, window: CompensationBudgetPeriodWindowV1): CompensationBudgetPeriodViewV1 {
    const projected = compensationBudgetPeriodViewV1(row, window)
    return {
        id: projected.id,
        periodKey: projected.periodKey,
        periodStartsAt: projected.periodStartsAt,
        periodEndsAt: projected.periodEndsAt,
        submissionClosesAt: projected.submissionClosesAt,
        state: projected.state,
        limitKopecks: projected.limitKopecks,
        reservedKopecks: projected.reservedKopecks,
        settledKopecks: projected.settledKopecks,
        remainingKopecks: projected.remainingKopecks,
    }
}
