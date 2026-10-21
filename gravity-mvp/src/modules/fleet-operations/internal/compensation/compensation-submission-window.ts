/**
 * Submission window and budget period selection.
 *
 * Two separate rules, both anchored on the order rather than on the clock:
 *
 *  - the budget period an application consumes is the business month of the
 *    order's completion, not the month the driver happened to submit in;
 *  - the submission deadline is the same for every order of a month: the end
 *    of the order's business month plus 72 hours. Once a month ends, the
 *    driver keeps three days to claim any eligible order of it, wherever in
 *    the month that order completed.
 *
 * Together these mean two budget periods legitimately accept work at the same
 * time during the first three days of a month, which is why a period is
 * selected by order and never by `now`.
 */

import {
    compensationCalendarMonthV1,
    compensationDaysInMonthV1,
    compensationCalendarDayV1,
    compensationMonthEndInstantV1,
    compensationPeriodKeyV1,
    type CompensationCalendarMonthV1,
} from './compensation-calendar'

/** Grace after a month ends during which any order of that month can still be claimed. */
export const MONTH_END_SUBMISSION_GRACE_MS = 72 * 60 * 60 * 1000

export interface CompensationSubmissionWindowV1 {
    /** Business month whose budget period this order consumes. */
    periodMonth: CompensationCalendarMonthV1
    /** `YYYY-MM` key of that period. */
    periodKey: string
    /** Exclusive instant at which submission for this order closes. */
    submissionDeadline: Date
    /**
     * Which product rule produced the deadline. One rule remains: the order's
     * month end plus the grace. The stored column's CHECK still admits the
     * retired `last_day_grace` value, which nothing writes any more.
     */
    deadlineBasis: 'order_month_end'
}

/**
 * The budget period an order belongs to. An order completed 31 Aug and
 * submitted 2 Sep reserves against August, never against September.
 */
export function compensationBudgetPeriodMonthV1(orderEndedAt: Date): CompensationCalendarMonthV1 {
    return compensationCalendarMonthV1(orderEndedAt)
}

/**
 * Product rule. Every order of a business month is claimable until that month
 * ends plus 72 hours: an October order, completed on the 1st or on the 31st,
 * can be submitted until 4 November 00:00 Yekaterinburg. The grace runs from
 * the month's end, never from the order's completion.
 *
 * The deadline is an exclusive bound: submission is open while
 * `now < submissionDeadline`.
 */
export function compensationSubmissionDeadlineV1(orderEndedAt: Date): Date {
    return compensationPeriodSubmissionClosesAtV1(compensationCalendarMonthV1(orderEndedAt))
}

/** Both order-derived facts a Submit needs, resolved once and stored on the claim. */
export function compensationSubmissionWindowV1(orderEndedAt: Date): CompensationSubmissionWindowV1 {
    const periodMonth = compensationBudgetPeriodMonthV1(orderEndedAt)
    return {
        periodMonth,
        periodKey: compensationPeriodKeyV1(periodMonth),
        submissionDeadline: compensationSubmissionDeadlineV1(orderEndedAt),
        deadlineBasis: 'order_month_end',
    }
}

/** Submission is open while `now` is strictly before the stored deadline. */
export function isSubmissionWindowOpenV1(now: Date, submissionDeadline: Date): boolean {
    return now.getTime() < submissionDeadline.getTime()
}

/**
 * The instant at which a month stops accepting new submissions: the month's end
 * plus the grace. Every order of the month shares it as its own deadline, and a
 * budget period stays open until then.
 */
export function compensationPeriodSubmissionClosesAtV1(month: CompensationCalendarMonthV1): Date {
    return new Date(compensationMonthEndInstantV1(month).getTime() + MONTH_END_SUBMISSION_GRACE_MS)
}

/**
 * Second attempt reuses the original order's deadline verbatim. Exposed as a
 * named function so the rule is stated once and cannot drift into a fresh
 * window at resubmission time.
 */
export function compensationResubmitDeadlineV1(originalSubmissionDeadline: Date): Date {
    return new Date(originalSubmissionDeadline.getTime())
}

/** Diagnostic helper used by tests and audit payloads. */
export function describeCompensationWindowV1(orderEndedAt: Date): string {
    const day = compensationCalendarDayV1(orderEndedAt)
    const window = compensationSubmissionWindowV1(orderEndedAt)
    const inMonth = compensationDaysInMonthV1({ year: day.year, month: day.month })
    return `${window.periodKey} day ${day.day}/${inMonth} basis=${window.deadlineBasis}`
}
