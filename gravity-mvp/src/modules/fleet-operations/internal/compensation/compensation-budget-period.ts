/**
 * Provisioning one compensation budget month, as a decision.
 *
 * A month is the monetary core's own ledger row: it holds the limit an operator
 * authorised and the reserved and settled counters C1 maintains. Nothing here
 * touches those counters — this module only decides whether a month must be
 * opened, whether its limit may move, and which window the month covers.
 *
 * The window is never accepted from a caller. Period key in, month out: the
 * same business calendar and the same submission deadline the rest of the
 * monetary core already uses, so an operator cannot provision a month whose
 * boundaries disagree with the applications that will charge it.
 *
 * Lowering a limit is refused rather than implemented. Money is already
 * reserved against it, so shrinking is a monetary decision with its own
 * invariants, and this milestone does not make it.
 */

import {
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
    parseCompensationPeriodKeyV1,
} from './compensation-calendar'
import { compensationDerivedIdV1 } from './compensation-identity'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'

/** The one state a month accepts submissions in. */
export const COMPENSATION_BUDGET_PERIOD_OPEN_STATE_V1 = 'open'

/** `CompensationBudgetPeriod.limitKopecks` is a 32-bit integer column. */
export const COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1 = 2_147_483_647

const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/u

export interface CompensationBudgetPeriodWindowV1 {
    periodKey: string
    periodStartsAt: Date
    periodEndsAt: Date
    submissionClosesAt: Date
}

/** The stored month, as the provisioning port reads it. */
export interface CompensationBudgetPeriodRowV1 {
    id: string
    periodKey: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
}

export const COMPENSATION_BUDGET_PERIOD_OUTCOMES_V1 = [
    'created',
    'already_configured',
    'limit_increased',
] as const
export type CompensationBudgetPeriodOutcomeV1 = typeof COMPENSATION_BUDGET_PERIOD_OUTCOMES_V1[number]

export const COMPENSATION_BUDGET_PERIOD_REFUSALS_V1 = [
    'invalid_period_key',
    'invalid_limit',
    'period_not_open',
    'limit_below_configured',
] as const
export type CompensationBudgetPeriodRefusalV1 = typeof COMPENSATION_BUDGET_PERIOD_REFUSALS_V1[number]

export type CompensationBudgetPeriodPlanV1 =
    | { action: 'create'; window: CompensationBudgetPeriodWindowV1; id: string; limitKopecks: number }
    | { action: 'increase'; id: string; limitKopecks: number }
    | { action: 'none' }
    | { refusal: CompensationBudgetPeriodRefusalV1 }

/**
 * The month a period key names, on the compensation business calendar.
 *
 * Returns null for anything that is not a month this calendar can state, so a
 * caller cannot smuggle an arbitrary window past the parser.
 */
export function compensationBudgetPeriodWindowV1(periodKey: unknown): CompensationBudgetPeriodWindowV1 | null {
    if (typeof periodKey !== 'string' || !PERIOD_KEY.test(periodKey)) return null
    const month = parseCompensationPeriodKeyV1(periodKey)
    // The key must be exactly what this calendar would print for that month.
    if (compensationPeriodKeyV1(month) !== periodKey) return null
    const periodStartsAt = compensationMonthStartInstantV1(month)
    const periodEndsAt = compensationMonthEndInstantV1(month)
    const submissionClosesAt = compensationPeriodSubmissionClosesAtV1(month)
    for (const instant of [periodStartsAt, periodEndsAt, submissionClosesAt]) {
        if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return null
    }
    return { periodKey, periodStartsAt, periodEndsAt, submissionClosesAt }
}

/** The month's row identity, derived so two concurrent callers agree on it. */
export function compensationBudgetPeriodIdV1(periodKey: string): string {
    return compensationDerivedIdV1('comp_period', periodKey)
}

export function isCompensationBudgetLimitV1(limitKopecks: unknown): limitKopecks is number {
    return typeof limitKopecks === 'number'
        && Number.isSafeInteger(limitKopecks)
        && limitKopecks > 0
        && limitKopecks <= COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1
}

/**
 * What provisioning this month must do, given the month storage holds now.
 *
 * `null` means no row exists yet. The same decision is taken again under the
 * row lock, so a month that appeared in between is handled as the month it is
 * rather than as the month the caller last saw.
 */
export function planCompensationBudgetPeriodV1(
    input: { periodKey: unknown; limitKopecks: unknown },
    existing: CompensationBudgetPeriodRowV1 | null,
): CompensationBudgetPeriodPlanV1 {
    const window = compensationBudgetPeriodWindowV1(input.periodKey)
    if (window === null) return { refusal: 'invalid_period_key' }
    if (!isCompensationBudgetLimitV1(input.limitKopecks)) return { refusal: 'invalid_limit' }
    const id = compensationBudgetPeriodIdV1(window.periodKey)

    if (existing === null) return { action: 'create', window, id, limitKopecks: input.limitKopecks }
    // A closed month is not reopened by provisioning it again: closing is a
    // monetary decision, and undoing it silently would resurrect a budget.
    if (existing.state !== COMPENSATION_BUDGET_PERIOD_OPEN_STATE_V1) return { refusal: 'period_not_open' }
    if (existing.limitKopecks === input.limitKopecks) return { action: 'none' }
    if (existing.limitKopecks > input.limitKopecks) return { refusal: 'limit_below_configured' }
    return { action: 'increase', id: existing.id, limitKopecks: input.limitKopecks }
}

/** What an operator sees after provisioning: the month, stated by storage. */
export interface CompensationBudgetPeriodViewV1 extends CompensationBudgetPeriodWindowV1 {
    id: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
    remainingKopecks: number
}

/**
 * Remaining is the monetary core's own arithmetic, never a second formula.
 */
export function compensationBudgetPeriodViewV1(
    row: CompensationBudgetPeriodRowV1,
    window: CompensationBudgetPeriodWindowV1,
): CompensationBudgetPeriodViewV1 {
    return {
        id: row.id,
        periodKey: window.periodKey,
        periodStartsAt: window.periodStartsAt,
        periodEndsAt: window.periodEndsAt,
        submissionClosesAt: window.submissionClosesAt,
        state: row.state,
        limitKopecks: row.limitKopecks,
        reservedKopecks: row.reservedKopecks,
        settledKopecks: row.settledKopecks,
        remainingKopecks: Math.max(0, row.limitKopecks - row.reservedKopecks - row.settledKopecks),
    }
}
