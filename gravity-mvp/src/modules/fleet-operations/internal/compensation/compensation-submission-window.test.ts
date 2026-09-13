import { describe, expect, it } from 'vitest'
import {
    compensationBusinessDayKeyV1,
    compensationDaysInMonthV1,
    compensationMonthEndInstantV1,
    compensationPeriodKeyV1,
    isLastBusinessDayOfMonthV1,
} from './compensation-calendar'
import {
    LAST_DAY_SUBMISSION_GRACE_MS,
    compensationBudgetPeriodMonthV1,
    compensationPeriodSubmissionClosesAtV1,
    compensationResubmitDeadlineV1,
    compensationSubmissionDeadlineV1,
    compensationSubmissionWindowV1,
    isSubmissionWindowOpenV1,
} from './compensation-submission-window'

/** Asia/Yekaterinburg is UTC+5; 18:00 local is 13:00Z the same day. */
const ykb = (iso: string): Date => new Date(iso)

describe('business calendar', () => {
    it('resolves the business day in Yekaterinburg, not UTC', () => {
        // 19:30Z on 31 Aug is already 00:30 on 1 Sep in Yekaterinburg.
        expect(compensationBusinessDayKeyV1(ykb('2026-08-31T19:30:00.000Z'))).toBe('2026-09-01')
        // 18:30Z on 31 Aug is still 23:30 on 31 Aug locally.
        expect(compensationBusinessDayKeyV1(ykb('2026-08-31T18:30:00.000Z'))).toBe('2026-08-31')
    })

    it('knows the length of each month', () => {
        expect(compensationDaysInMonthV1({ year: 2026, month: 9 })).toBe(30)
        expect(compensationDaysInMonthV1({ year: 2026, month: 8 })).toBe(31)
        expect(compensationDaysInMonthV1({ year: 2026, month: 2 })).toBe(28)
        expect(compensationDaysInMonthV1({ year: 2028, month: 2 })).toBe(29)
    })

    it('places a month boundary at local midnight', () => {
        // 1 Sep 00:00 Yekaterinburg is 31 Aug 19:00Z.
        expect(compensationMonthEndInstantV1({ year: 2026, month: 8 }).toISOString())
            .toBe('2026-08-31T19:00:00.000Z')
        expect(compensationMonthEndInstantV1({ year: 2026, month: 12 }).toISOString())
            .toBe('2026-12-31T19:00:00.000Z')
    })

    it('identifies the last calendar day of a month', () => {
        expect(isLastBusinessDayOfMonthV1(ykb('2026-09-30T13:00:00.000Z'))).toBe(true)
        expect(isLastBusinessDayOfMonthV1(ykb('2026-09-29T13:00:00.000Z'))).toBe(false)
        // 30 Sep 19:30Z is 1 Oct locally, so it is not September's last day.
        expect(isLastBusinessDayOfMonthV1(ykb('2026-09-30T19:30:00.000Z'))).toBe(false)
    })
})

describe('submission deadline product rule', () => {
    it('gives a mid-month order the end of its own month', () => {
        // 10 Sep 15:00 local.
        const window = compensationSubmissionWindowV1(ykb('2026-09-10T10:00:00.000Z'))
        expect(window.periodKey).toBe('2026-09')
        expect(window.deadlineBasis).toBe('order_month_end')
        // End of 30 Sep local = 1 Oct 00:00 local = 30 Sep 19:00Z.
        expect(window.submissionDeadline.toISOString()).toBe('2026-09-30T19:00:00.000Z')
    })

    it('gives a last-day order 72 hours from completion', () => {
        // 30 Sep 18:00 local -> 3 Oct 18:00 local.
        const endedAt = ykb('2026-09-30T13:00:00.000Z')
        const window = compensationSubmissionWindowV1(endedAt)
        expect(window.periodKey).toBe('2026-09')
        expect(window.deadlineBasis).toBe('last_day_grace')
        expect(window.submissionDeadline.toISOString()).toBe('2026-10-03T13:00:00.000Z')
        expect(window.submissionDeadline.getTime() - endedAt.getTime()).toBe(LAST_DAY_SUBMISSION_GRACE_MS)
    })

    it('is not a generic 72-hour rule', () => {
        // A 10 Sep order gets twenty days, not three.
        const endedAt = ykb('2026-09-10T10:00:00.000Z')
        const deadline = compensationSubmissionDeadlineV1(endedAt)
        expect(deadline.getTime() - endedAt.getTime()).toBeGreaterThan(LAST_DAY_SUBMISSION_GRACE_MS)
    })

    it('treats the deadline as an exclusive bound', () => {
        const deadline = compensationSubmissionDeadlineV1(ykb('2026-09-10T10:00:00.000Z'))
        expect(isSubmissionWindowOpenV1(new Date(deadline.getTime() - 1), deadline)).toBe(true)
        expect(isSubmissionWindowOpenV1(new Date(deadline.getTime()), deadline)).toBe(false)
        expect(isSubmissionWindowOpenV1(new Date(deadline.getTime() + 1), deadline)).toBe(false)
    })

    it('reuses the original deadline for a second attempt', () => {
        const original = compensationSubmissionDeadlineV1(ykb('2026-09-30T13:00:00.000Z'))
        const resubmit = compensationResubmitDeadlineV1(original)
        expect(resubmit.toISOString()).toBe(original.toISOString())
    })
})

describe('budget period selection', () => {
    it('charges an order to the month it was completed in, not the month it was submitted in', () => {
        // Order completed 31 Aug 18:00 local, submitted 2 Sep.
        const endedAt = ykb('2026-08-31T13:00:00.000Z')
        const month = compensationBudgetPeriodMonthV1(endedAt)
        expect(compensationPeriodKeyV1(month)).toBe('2026-08')
        expect(compensationSubmissionWindowV1(endedAt).submissionDeadline.toISOString())
            .toBe('2026-09-03T13:00:00.000Z')
    })

    it('follows the local month across the UTC boundary', () => {
        // 19:30Z on 31 Aug is 1 Sep locally, so it belongs to September.
        const month = compensationBudgetPeriodMonthV1(ykb('2026-08-31T19:30:00.000Z'))
        expect(compensationPeriodKeyV1(month)).toBe('2026-09')
    })

    it('keeps a period open long enough for its own last-day grace', () => {
        const closesAt = compensationPeriodSubmissionClosesAtV1({ year: 2026, month: 8 })
        // 1 Sep 00:00 local plus 72 hours.
        expect(closesAt.toISOString()).toBe('2026-09-03T19:00:00.000Z')

        // The latest possible August deadline must not exceed it.
        const latestAugustOrder = ykb('2026-08-31T18:59:59.999Z') // 23:59:59.999 local
        const latestDeadline = compensationSubmissionDeadlineV1(latestAugustOrder)
        expect(latestDeadline.getTime()).toBeLessThanOrEqual(closesAt.getTime())
    })

    it('lets two periods accept work at the same time on 1-3 September', () => {
        const augustOrder = ykb('2026-08-31T13:00:00.000Z')
        const septemberOrder = ykb('2026-09-02T09:00:00.000Z')
        const now = ykb('2026-09-02T10:00:00.000Z')

        const august = compensationSubmissionWindowV1(augustOrder)
        const september = compensationSubmissionWindowV1(septemberOrder)

        expect(august.periodKey).toBe('2026-08')
        expect(september.periodKey).toBe('2026-09')
        expect(isSubmissionWindowOpenV1(now, august.submissionDeadline)).toBe(true)
        expect(isSubmissionWindowOpenV1(now, september.submissionDeadline)).toBe(true)
    })

    it('closes the last-day grace exactly 72 hours after completion', () => {
        const endedAt = ykb('2026-08-31T13:00:00.000Z')
        const deadline = compensationSubmissionDeadlineV1(endedAt)
        expect(isSubmissionWindowOpenV1(ykb('2026-09-03T12:59:59.999Z'), deadline)).toBe(true)
        expect(isSubmissionWindowOpenV1(ykb('2026-09-03T13:00:00.000Z'), deadline)).toBe(false)
    })
})
