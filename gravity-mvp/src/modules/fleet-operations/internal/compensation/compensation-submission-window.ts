/**
 * Submission window and budget period selection.
 *
 * Two separate rules, both anchored on the order rather than on the clock:
 *
 *  - the budget period an application consumes is the business month of the
 *    order's completion, not the month the driver happened to submit in;
 *  - the submission deadline is the end of the order's business month, except
 *    for an order completed on the last calendar day of its month, which gets
 *    72 hours from completion so that a late-evening last-day order is still
 *    claimable.
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
    isLastBusinessDayOfMonthV1,
    type CompensationCalendarMonthV1,
} from './compensation-calendar'

/** Grace granted to an order completed on the last calendar day of its month. */
export const LAST_DAY_SUBMISSION_GRACE_MS = 72 * 60 * 60 * 1000

export interface CompensationSubmissionWindowV1 {
    /** Business month whose budget period this order consumes. */
    periodMonth: CompensationCalendarMonthV1
    /** `YYYY-MM` key of that period. */
    periodKey: string
    /** Exclusive instant at which submission for this order closes. */
    submissionDeadline: Date
    /** Which limb of the product rule produced the deadline. */
    deadlineBasis: 'order_month_end' | 'last_day_grace'
}

/**
 * The budget period an order belongs to. An order completed 31 Aug and
 * submitted 2 Sep reserves against August, never against September.
 */
export function compensationBudgetPeriodMonthV1(orderEndedAt: Date): CompensationCalendarMonthV1 {
    return compensationCalendarMonthV1(orderEndedAt)
}

/**
 * Product rule. An order completed before the last calendar day of its month is
 * claimable until that month ends; an order completed on the last calendar day
 * is claimable for 72 hours from completion.
 *
 * The deadline is an exclusive bound: submission is open while
 * `now < submissionDeadline`.
 */
export function compensationSubmissionDeadlineV1(orderEndedAt: Date): Date {
    const month = compensationCalendarMonthV1(orderEndedAt)
    if (isLastBusinessDayOfMonthV1(orderEndedAt)) {
        return new Date(orderEndedAt.getTime() + LAST_DAY_SUBMISSION_GRACE_MS)
    }
    return compensationMonthEndInstantV1(month)
}

/** Both order-derived facts a Submit needs, resolved once and stored on the claim. */
export function compensationSubmissionWindowV1(orderEndedAt: Date): CompensationSubmissionWindowV1 {
    const periodMonth = compensationBudgetPeriodMonthV1(orderEndedAt)
    const lastDay = isLastBusinessDayOfMonthV1(orderEndedAt)
    return {
        periodMonth,
        periodKey: compensationPeriodKeyV1(periodMonth),
        submissionDeadline: compensationSubmissionDeadlineV1(orderEndedAt),
        deadlineBasis: lastDay ? 'last_day_grace' : 'order_month_end',
    }
}

/** Submission is open while `now` is strictly before the stored deadline. */
export function isSubmissionWindowOpenV1(now: Date, submissionDeadline: Date): boolean {
    return now.getTime() < submissionDeadline.getTime()
}

/**
 * The latest instant at which any order of a month can still be submitted: the
 * month's end plus the last-day grace. A budget period must stay open until
 * then, otherwise a valid last-day submission would find its own period closed.
 */
export function compensationPeriodSubmissionClosesAtV1(month: CompensationCalendarMonthV1): Date {
    return new Date(compensationMonthEndInstantV1(month).getTime() + LAST_DAY_SUBMISSION_GRACE_MS)
}

/**
 * Second attempt reuses the original order's deadline verbatim. Exposed as a
 * named function so the rule is stated once and cannot drift into a fresh
 * 72-hour window at resubmission time.
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
