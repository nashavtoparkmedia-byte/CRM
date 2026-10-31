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
    compensationBudgetProvisioningPeriodKeysV1,
    isCompensationBudgetLimitV1,
    parseCompensationMonthlyBudgetLimitV1,
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

describe('create-only, the scheduler\'s mode', () => {
    it('opens a month that does not exist, exactly as an operator would', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-11', limitKopecks: 500_000, createOnly: true }, null))
            .toEqual(planCompensationBudgetPeriodV1({ periodKey: '2026-11', limitKopecks: 500_000 }, null))
    })

    it('never raises a stored limit', () => {
        expect(planCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 900_000, createOnly: true },
            row({ limitKopecks: 300_000 }),
        )).toEqual({ action: 'none' })
    })

    it('leaves a month above the configured limit as it is, without refusing', () => {
        expect(planCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 500_000, createOnly: true },
            row({ limitKopecks: 700_000 }),
        )).toEqual({ action: 'none' })
    })

    it('leaves a closed month closed', () => {
        expect(planCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 500_000, createOnly: true },
            row({ state: 'closed' }),
        )).toEqual({ action: 'none' })
    })

    it('still refuses an unusable key or limit', () => {
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-13', limitKopecks: 500_000, createOnly: true }, null))
            .toEqual({ refusal: 'invalid_period_key' })
        expect(planCompensationBudgetPeriodV1({ periodKey: '2026-11', limitKopecks: 0, createOnly: true }, null))
            .toEqual({ refusal: 'invalid_limit' })
    })
})

describe('the months the scheduler keeps open', () => {
    it('is the business month of the instant and the next one, on the Yekaterinburg calendar', () => {
        // 2026-10-31 23:59:59.999 in Yekaterinburg is still October.
        expect(compensationBudgetProvisioningPeriodKeysV1(new Date('2026-10-31T18:59:59.999Z'))).toEqual(['2026-10', '2026-11'])
        // Its midnight is 19:00 UTC: November starts, and December is prepared.
        expect(compensationBudgetProvisioningPeriodKeysV1(new Date('2026-10-31T19:00:00.000Z'))).toEqual(['2026-11', '2026-12'])
    })

    it('rolls over the year', () => {
        expect(compensationBudgetProvisioningPeriodKeysV1(new Date('2026-12-15T10:00:00Z'))).toEqual(['2026-12', '2027-01'])
        expect(compensationBudgetProvisioningPeriodKeysV1(new Date('2026-12-31T19:00:00Z'))).toEqual(['2027-01', '2027-02'])
    })

    it('never names October again once November has started, so its 72-hour grace is left to the stored month', () => {
        const insideGrace = new Date('2026-11-02T10:00:00Z')
        expect(insideGrace.getTime()).toBeLessThan(compensationBudgetPeriodWindowV1('2026-10')!.submissionClosesAt.getTime())
        expect(compensationBudgetProvisioningPeriodKeysV1(insideGrace)).toEqual(['2026-11', '2026-12'])
    })

    it('names keys the period parser accepts', () => {
        for (const instant of ['2026-01-01T00:00:00Z', '2026-06-30T19:00:00Z', '2027-02-28T18:59:59Z']) {
            for (const key of compensationBudgetProvisioningPeriodKeysV1(new Date(instant))) {
                expect(compensationBudgetPeriodWindowV1(key)).not.toBeNull()
            }
        }
    })
})

describe('the configured monthly limit', () => {
    it('reads whole kopecks', () => {
        expect(parseCompensationMonthlyBudgetLimitV1('500000')).toBe(500_000)
        expect(parseCompensationMonthlyBudgetLimitV1(String(COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1)))
            .toBe(COMPENSATION_BUDGET_LIMIT_MAX_KOPECKS_V1)
    })

    it('treats anything else, unset included, as no limit, never as a default', () => {
        for (const raw of [undefined, null, '', ' 500000', '500000 ', '5000.00', '5 000', '-1', '0', '0500000', '1e6',
            '2147483648', '99999999999', 'abc', 500_000]) {
            expect(parseCompensationMonthlyBudgetLimitV1(raw)).toBeNull()
        }
    })
})
