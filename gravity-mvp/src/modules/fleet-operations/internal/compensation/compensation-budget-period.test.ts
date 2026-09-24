import { describe, expect, it } from 'vitest'

import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
} from './compensation-calendar'
import {
    COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1,
    compensationBudgetPeriodIdV1,
    compensationBudgetPeriodViewV1,
    compensationBudgetPeriodWindowV1,
    isCompensationBudgetLimitV1,
    planCompensationBudgetPeriodV1,
    type CompensationBudgetPeriodRowV1,
} from './compensation-budget-period'
import { compensationPeriodSubmissionClosesAtV1 } from './compensation-submission-window'

/**
 * Provisioning a month, as a decision.
 *
 * The window is derived, never accepted; the limit only ever moves up; a closed
 * month is never reopened by asking for it again.
 */

const row = (over: Partial<CompensationBudgetPeriodRowV1> = {}): CompensationBudgetPeriodRowV1 => ({
    id: 'comp_period_x',
    periodKey: '2026-09',
    state: 'open',
    limitKopecks: 500_000,
    reservedKopecks: 0,
    settledKopecks: 0,
    ...over,
})

describe('the month a period key names', () => {
    it('derives the window from the monetary core calendar, not from the caller', () => {
        const month = compensationCalendarMonthV1(new Date('2026-09-15T00:00:00.000Z'))
        expect(compensationBudgetPeriodWindowV1('2026-09')).toEqual({
            periodKey: '2026-09',
            periodStartsAt: compensationMonthStartInstantV1(month),
            periodEndsAt: compensationMonthEndInstantV1(month),
            submissionClosesAt: compensationPeriodSubmissionClosesAtV1(month),
        })
    })

    it('derives a different month for every key it accepts', () => {
        const september = compensationBudgetPeriodWindowV1('2026-09')!
        const october = compensationBudgetPeriodWindowV1('2026-10')!
        expect(september.periodEndsAt.getTime()).toBeLessThanOrEqual(october.periodStartsAt.getTime())
        expect(compensationPeriodKeyV1(compensationCalendarMonthV1(september.periodStartsAt))).toBe('2026-09')
        expect(compensationPeriodKeyV1(compensationCalendarMonthV1(october.periodStartsAt))).toBe('2026-10')
    })

    it.each([
        '2026-13', '2026-00', '2026-9', '26-09', '2026-09-01', 'september', '', ' 2026-09',
    ])('refuses the unusable key %p', (key) => {
        expect(compensationBudgetPeriodWindowV1(key)).toBeNull()
    })

    it.each([null, undefined, 202609, {}, ['2026-09']])('refuses the non-string key %p', (key) => {
        expect(compensationBudgetPeriodWindowV1(key)).toBeNull()
    })

    it('gives one month one identity', () => {
        expect(compensationBudgetPeriodIdV1('2026-09')).toBe(compensationBudgetPeriodIdV1('2026-09'))
        expect(compensationBudgetPeriodIdV1('2026-09')).not.toBe(compensationBudgetPeriodIdV1('2026-10'))
        expect(compensationBudgetPeriodIdV1('2026-09')).toMatch(/^comp_period_[0-9a-f]{64}$/u)
    })
})

describe('the limit a month may carry', () => {
    it('accepts a whole positive number of kopecks the ledger column can hold', () => {
        expect(isCompensationBudgetLimitV1(1)).toBe(true)
        expect(isCompensationBudgetLimitV1(500_000)).toBe(true)
        expect(isCompensationBudgetLimitV1(COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1)).toBe(true)
    })

    it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1 + 1])(
        'refuses %p',
        (limit) => { expect(isCompensationBudgetLimitV1(limit)).toBe(false) },
    )

    it.each(['500000', null, undefined, {}])('refuses the non-number %p', (limit) => {
        expect(isCompensationBudgetLimitV1(limit)).toBe(false)
    })
})

describe('what provisioning decides', () => {
    it('opens a month that does not exist', () => {
        const plan = planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 500_000 }, null)
        expect(plan).toMatchObject({ action: 'create', limitKopecks: 500_000 })
        expect(plan).toHaveProperty('window.periodKey', '2026-09')
        expect(plan).toHaveProperty('id', compensationBudgetPeriodIdV1('2026-09'))
    })

    it('does nothing when the month already carries exactly this limit', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 500_000 }, row()))
            .toEqual({ action: 'none' })
    })

    it('raises a limit', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 700_000 }, row()))
            .toEqual({ action: 'increase', id: 'comp_period_x', limitKopecks: 700_000 })
    })

    it('refuses to lower a limit money is already reserved against', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 300_000 }, row()))
            .toEqual({ refusal: 'limit_below_configured' })
    })

    it.each(['closed', 'settled', 'frozen'])('refuses to reopen a %s month', (state) => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 900_000 }, row({ state })))
            .toEqual({ refusal: 'period_not_open' })
    })

    it('refuses an unusable key or limit before anything else', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-13', limitKopecks: 500_000 }, null))
            .toEqual({ refusal: 'invalid_period_key' })
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 0 }, null))
            .toEqual({ refusal: 'invalid_limit' })
        // A closed month with an unusable limit is still an unusable limit.
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: -5 }, row({ state: 'closed' })))
            .toEqual({ refusal: 'invalid_limit' })
    })
})

describe('the month as an operator reads it', () => {
    const window = compensationBudgetPeriodWindowV1('2026-09')!

    it('takes remaining from the ledger counters', () => {
        expect(compensationBudgetPeriodViewV1(
            row({ limitKopecks: 500_000, reservedKopecks: 30_000, settledKopecks: 20_000 }),
            window,
        )).toMatchObject({ limitKopecks: 500_000, reservedKopecks: 30_000, settledKopecks: 20_000, remainingKopecks: 450_000 })
    })

    it('never shows a negative remaining', () => {
        expect(compensationBudgetPeriodViewV1(
            row({ limitKopecks: 10_000, reservedKopecks: 9_000, settledKopecks: 5_000 }),
            window,
        ).remainingKopecks).toBe(0)
    })

    it('reports the derived window, not a stored one', () => {
        expect(compensationBudgetPeriodViewV1(row(), window)).toMatchObject({
            periodKey: '2026-09',
            periodStartsAt: window.periodStartsAt,
            submissionClosesAt: window.submissionClosesAt,
        })
    })
})
