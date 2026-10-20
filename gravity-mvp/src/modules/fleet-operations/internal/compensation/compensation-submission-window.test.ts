import { describe, expect, it } from 'vitest'
import {
    compensationBusinessDayKeyV1,
    compensationDaysInMonthV1,
    compensationMonthEndInstantV1,
    compensationPeriodKeyV1,
    isLastBusinessDayOfMonthV1,
} from './compensation-calendar'
import {
    MONTH_END_SUBMISSION_GRACE_MS,
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

describe('submission deadline product rule: the month\'s end plus 72 hours', () => {
    /** 4 November 00:00 Yekaterinburg = 3 November 19:00Z: exclusive deadline for every October order. */
    const OCTOBER_DEADLINE = '2026-11-03T19:00:00.000Z'
    const octoberOrders = {
        // 1 October 10:00, 15 October 15:00, 30 October 12:00, 31 October 23:30 Yekaterinburg.
        '1 Oct': ykb('2026-10-01T05:00:00.000Z'),
        '15 Oct': ykb('2026-10-15T10:00:00.000Z'),
        '30 Oct': ykb('2026-10-30T07:00:00.000Z'),
        '31 Oct': ykb('2026-10-31T18:30:00.000Z'),
    }
    const submissions = {
        // 1 Nov 12:00, 2 Nov 12:00, 3 Nov 23:59:59, 3 Nov 23:59:59.999 Yekaterinburg: open.
        open: [ykb('2026-11-01T07:00:00.000Z'), ykb('2026-11-02T07:00:00.000Z'), ykb('2026-11-03T18:59:59.000Z'), ykb('2026-11-03T18:59:59.999Z')],
        // 4 Nov 00:00 and 4 Nov 00:00:01 Yekaterinburg: closed.
        closed: [ykb('2026-11-03T19:00:00.000Z'), ykb('2026-11-03T19:00:01.000Z')],
    }

    for (const [label, endedAt] of Object.entries(octoberOrders)) {
        it(`gives an order of ${label} the same deadline, 4 November 00:00 Yekaterinburg`, () => {
            const window = compensationSubmissionWindowV1(endedAt)
            expect(window.periodKey).toBe('2026-10')
            expect(window.deadlineBasis).toBe('order_month_end')
            expect(window.submissionDeadline.toISOString()).toBe(OCTOBER_DEADLINE)
            expect(compensationSubmissionDeadlineV1(endedAt).toISOString()).toBe(OCTOBER_DEADLINE)
        })

        it(`accepts an order of ${label} on 1, 2 and 3 November up to 23:59:59.999, and refuses it from 4 November 00:00`, () => {
            const deadline = compensationSubmissionDeadlineV1(endedAt)
            for (const now of submissions.open) expect(isSubmissionWindowOpenV1(now, deadline)).toBe(true)
            for (const now of submissions.closed) expect(isSubmissionWindowOpenV1(now, deadline)).toBe(false)
        })
    }

    it('no longer runs 72 hours from a last-day completion', () => {
        // 31 October 01:00 Yekaterinburg: the old rule closed this order on 3 November 01:00.
        const earlyLastDay = ykb('2026-10-30T20:00:00.000Z')
        expect(isLastBusinessDayOfMonthV1(earlyLastDay)).toBe(true)
        const deadline = compensationSubmissionDeadlineV1(earlyLastDay)
        expect(deadline.toISOString()).toBe(OCTOBER_DEADLINE)
        expect(isSubmissionWindowOpenV1(ykb('2026-11-03T07:00:00.000Z'), deadline)).toBe(true)
        // 31 October 23:30: the old rule left this order open until 3 November 23:30, the new rule a bit longer.
        const lateLastDay = octoberOrders['31 Oct']
        expect(compensationSubmissionDeadlineV1(lateLastDay).getTime() - lateLastDay.getTime())
            .not.toBe(MONTH_END_SUBMISSION_GRACE_MS)
    })

    it('runs the grace from the month\'s end, not from completion', () => {
        const monthEnd = compensationMonthEndInstantV1({ year: 2026, month: 10 })
        for (const endedAt of Object.values(octoberOrders)) {
            expect(compensationSubmissionDeadlineV1(endedAt).getTime() - monthEnd.getTime()).toBe(MONTH_END_SUBMISSION_GRACE_MS)
        }
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
        expect(resubmit.toISOString()).toBe('2026-10-03T19:00:00.000Z')
    })

    it('moves to the next year at December\'s end', () => {
        // 1 January 00:00 Yekaterinburg plus 72 hours = 4 January 00:00 = 3 January 19:00Z.
        expect(compensationSubmissionDeadlineV1(ykb('2026-12-15T10:00:00.000Z')).toISOString()).toBe('2027-01-03T19:00:00.000Z')
    })
})

describe('budget period selection', () => {
    it('charges an order to the month it was completed in, not the month it was submitted in', () => {
        // Order completed 31 Aug 18:00 local, submitted 2 Sep.
        const endedAt = ykb('2026-08-31T13:00:00.000Z')
        const month = compensationBudgetPeriodMonthV1(endedAt)
        expect(compensationPeriodKeyV1(month)).toBe('2026-08')
        expect(compensationSubmissionWindowV1(endedAt).submissionDeadline.toISOString())
            .toBe('2026-09-03T19:00:00.000Z')
    })

    it('follows the local month across the UTC boundary', () => {
        // 19:30Z on 31 Aug is 1 Sep locally, so it belongs to September.
        const month = compensationBudgetPeriodMonthV1(ykb('2026-08-31T19:30:00.000Z'))
        expect(compensationPeriodKeyV1(month)).toBe('2026-09')
    })

    it('closes a period for new submissions exactly at its orders\' shared deadline', () => {
        const closesAt = compensationPeriodSubmissionClosesAtV1({ year: 2026, month: 10 })
        expect(closesAt.toISOString()).toBe('2026-11-03T19:00:00.000Z')
        for (const endedAt of [ykb('2026-09-30T19:00:00.000Z'), ykb('2026-10-15T10:00:00.000Z'), ykb('2026-10-31T18:59:59.999Z')]) {
            expect(compensationSubmissionDeadlineV1(endedAt).getTime()).toBe(closesAt.getTime())
        }
    })

    it('lets two periods accept work at the same time on 1-3 November, each charged to its own month', () => {
        const octoberOrder = ykb('2026-10-15T10:00:00.000Z')
        const novemberOrder = ykb('2026-11-02T09:00:00.000Z')
        const now = ykb('2026-11-02T10:00:00.000Z')

        const october = compensationSubmissionWindowV1(octoberOrder)
        const november = compensationSubmissionWindowV1(novemberOrder)

        expect(october.periodKey).toBe('2026-10')
        expect(november.periodKey).toBe('2026-11')
        expect(isSubmissionWindowOpenV1(now, october.submissionDeadline)).toBe(true)
        expect(isSubmissionWindowOpenV1(now, november.submissionDeadline)).toBe(true)
        expect(november.submissionDeadline.toISOString()).toBe('2026-12-03T19:00:00.000Z')
    })
})
