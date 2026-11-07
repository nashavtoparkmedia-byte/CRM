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
    compensationBudgetProvisioningPeriodKeysV1,
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
        /** Re-decide in create-only mode: a month found under the lock is left as it is. */
        createOnly?: boolean
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
    /**
     * Open a missing month and never change a stored one: no limit moves, no
     * state changes, and a month that exists is not even locked.
     */
    createOnly?: boolean
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
    const createOnly = input.createOnly === true
    const window = compensationBudgetPeriodWindowV1(input.periodKey)
    if (window === null) {
        return { ok: false, dryRun, outcome: null, refusal: 'invalid_period_key', period: null }
    }

    const existing = await port.findPeriod(window.periodKey)
    const plan = planCompensationBudgetPeriodV1(
        { periodKey: window.periodKey, limitKopecks: input.limitKopecks, createOnly },
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

    // Create-only has nothing it may change in a stored month, so it does not
    // take that month's lock: C1 reserving against it is never kept waiting.
    if (createOnly && existing !== null) {
        return { ok: true, dryRun: false, outcome: 'already_configured', refusal: null, period: view(existing, window) }
    }

    const stored = await port.provisionPeriod({
        window,
        id: plan.action === 'create' ? plan.id : plan.action === 'increase' ? plan.id : existing!.id,
        limitKopecks: plan.action === 'none' ? existing!.limitKopecks : plan.limitKopecks,
        ...(createOnly ? { createOnly: true } : {}),
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

export const COMPENSATION_BUDGET_PROVISIONING_STATUSES_V1 = [
    /** Opened by this run at the configured limit. */
    'created',
    /** Already stored; left exactly as it is. */
    'present',
    /** Not stored, and no limit is configured to open it with. */
    'missing_unconfigured',
    /** The seam refused the month or the configured limit. */
    'refused',
    /** Storage failed; the next run tries again. */
    'failed',
] as const
export type CompensationBudgetProvisioningStatusV1 = typeof COMPENSATION_BUDGET_PROVISIONING_STATUSES_V1[number]

export interface CompensationBudgetProvisioningMonthV1 {
    periodKey: string
    status: CompensationBudgetProvisioningStatusV1
    /** The stored limit after the run; null when no month is stored. */
    limitKopecks: number | null
    /** The configured limit, which differs from a stored month's when an operator set that month otherwise. */
    limitDiffersFromConfiguration: boolean
    state: string | null
    refusal: CompensationBudgetPeriodRefusalV1 | null
    error: string | null
}

export interface CompensationBudgetProvisioningRunV1 {
    /** Every month this run keeps open is stored afterwards, and nothing failed. */
    ok: boolean
    configuredLimitKopecks: number | null
    months: CompensationBudgetProvisioningMonthV1[]
}

/**
 * Scheduled provisioning: opens the current and the next business month at the
 * configured limit, in create-only mode, one month at a time so a failure in
 * one does not stop the other.
 *
 * With no configured limit it writes nothing and only reports which months are
 * missing. It never moves a stored limit, never reopens a closed month, and
 * never reads or writes reserved or settled.
 */
export async function provisionCompensationBudgetPeriodsV1(
    input: { now: Date; limitKopecks: number | null },
    port: CompensationBudgetPeriodPortV1,
): Promise<CompensationBudgetProvisioningRunV1> {
    const months: CompensationBudgetProvisioningMonthV1[] = []
    for (const periodKey of compensationBudgetProvisioningPeriodKeysV1(input.now)) {
        months.push(await provisionMonth(periodKey, input.limitKopecks, port))
    }
    return {
        ok: months.every((month) => month.status === 'created' || month.status === 'present'),
        configuredLimitKopecks: input.limitKopecks,
        months,
    }
}

async function provisionMonth(
    periodKey: string,
    limitKopecks: number | null,
    port: CompensationBudgetPeriodPortV1,
): Promise<CompensationBudgetProvisioningMonthV1> {
    const stated = (
        status: CompensationBudgetProvisioningStatusV1,
        period: CompensationBudgetPeriodViewV1 | CompensationBudgetPeriodRowV1 | null,
        extra: { refusal?: CompensationBudgetPeriodRefusalV1; error?: string } = {},
    ): CompensationBudgetProvisioningMonthV1 => ({
        periodKey,
        status,
        limitKopecks: period === null ? null : period.limitKopecks,
        limitDiffersFromConfiguration: period !== null && limitKopecks !== null && period.limitKopecks !== limitKopecks,
        state: period === null ? null : period.state,
        refusal: extra.refusal ?? null,
        error: extra.error ?? null,
    })
    try {
        if (limitKopecks === null) {
            const existing = await port.findPeriod(periodKey)
            return existing === null ? stated('missing_unconfigured', null) : stated('present', existing)
        }
        const result = await ensureCompensationBudgetPeriodV1({ periodKey, limitKopecks, createOnly: true }, port)
        if (!result.ok) return stated('refused', result.period, { refusal: result.refusal ?? undefined })
        return stated(result.outcome === 'created' ? 'created' : 'present', result.period)
    } catch (error: unknown) {
        return stated('failed', null, { error: error instanceof Error ? error.message : String(error) })
    }
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
