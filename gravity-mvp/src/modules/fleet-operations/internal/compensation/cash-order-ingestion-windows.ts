/**
 * Booking windows and reconciliation pass state for cash-order ingestion.
 *
 * Pure functions over database times. Every calendar boundary is an
 * Asia/Yekaterinburg business day or month from the compensation calendar.
 *
 * Reconciliation is completeness work, never a monetary freshness authority:
 * nothing here can change a submission threshold, and a slow or failing pass
 * only raises the completeness alarms below.
 */

import {
    compensationCalendarMonthV1,
    compensationDayEndInstantV1,
    compensationDayStartInstantV1,
    compensationMonthStartInstantV1,
    parseCompensationBusinessDayKeyV1,
} from './compensation-calendar'
import type { CashOrderIngestionProgressV1 } from './cash-order-ingestion-store'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const CASH_ORDER_WINDOWS_V1 = Object.freeze({
    HOT_LOOKBACK_MS: 3 * HOUR,
    BOOKING_LOOKAHEAD_MS: 10 * MINUTE,
    /** No successful hot pass for this long restarts reconciliation. */
    GAP_RESTART_MS: 30 * MINUTE,
    /** Regular passes start this long after the previous start. */
    RECONCILIATION_PERIOD_MS: 6 * HOUR,
    SLICE_MS: 6 * HOUR,
    /** Previous-month days stay reconciled while they are within this of now. */
    PREVIOUS_MONTH_EDGE_MS: 72 * HOUR,
    /** booked_at can precede the business day it completes in by up to a day. */
    BOOKING_MARGIN_MS: 24 * HOUR,
    DRY_RUN_HORIZON_MS: 31 * DAY,
    PASS_IN_PROGRESS_ALARM_MS: 3 * HOUR,
    COMPLETION_AGE_ALARM_MS: 12 * HOUR,
    HOT_AGE_ALARM_MS: 10 * MINUTE,
    /** booked_at can follow ended_at by minutes, so a day window reaches past its end. */
    DAY_UPPER_MARGIN_MS: 30 * MINUTE,
    NARROW_HALF_WIDTH_MS: 5 * MINUTE,
})

const W = CASH_ORDER_WINDOWS_V1

export interface BookingWindowV1 {
    from: Date
    to: Date
}

const at = (ms: number) => new Date(ms)

/** The hot window of a pass that started at database time S. */
export function hotWindowV1(startedAt: Date): BookingWindowV1 {
    return {
        from: at(startedAt.getTime() - W.HOT_LOOKBACK_MS),
        to: at(startedAt.getTime() + W.BOOKING_LOOKAHEAD_MS),
    }
}

/**
 * Lowest booked_at reconciliation reaches: the current business month, plus
 * previous-month days while now − 72 h still reaches into them, less the 24 h
 * booking margin.
 */
export function reconciliationFloorV1(dbNow: Date): Date {
    const monthStart = compensationMonthStartInstantV1(compensationCalendarMonthV1(dbNow)).getTime()
    return at(Math.min(monthStart, dbNow.getTime() - W.PREVIOUS_MONTH_EDGE_MS) - W.BOOKING_MARGIN_MS)
}

/** Dry-run passes measure a month-end-sized horizon on any calendar day. */
export function dryRunReconciliationFloorV1(dbNow: Date): Date {
    return at(dbNow.getTime() - W.DRY_RUN_HORIZON_MS - W.BOOKING_MARGIN_MS)
}

export interface ReconciliationPassV1 {
    passStartedAt: Date | null
    floor: Date | null
    cursor: Date | null
    completedAt: Date | null
}

export function reconciliationPassOfV1(progress: CashOrderIngestionProgressV1): ReconciliationPassV1 {
    return {
        passStartedAt: progress.reconciliationPassStartedAt,
        floor: progress.reconciliationFloorBookedAt,
        cursor: progress.reconciliationCursorBookedAt,
        completedAt: progress.lastReconciliationCompletedAt,
    }
}

export type ReconciliationPassStateV1 = 'not_started' | 'in_progress' | 'complete'

/** In progress while there is no completion at or after the current pass start. */
export function reconciliationPassStateV1(pass: ReconciliationPassV1): ReconciliationPassStateV1 {
    if (pass.passStartedAt === null) return 'not_started'
    if (pass.completedAt === null || pass.completedAt.getTime() < pass.passStartedAt.getTime()) return 'in_progress'
    return 'complete'
}

/** A hot pass starting at S finds no successful hot pass in the last 30 min. */
export function gapRestartRequiredV1(lastHotSuccessAt: Date | null, startedAt: Date): boolean {
    return lastHotSuccessAt === null || lastHotSuccessAt.getTime() < startedAt.getTime() - W.GAP_RESTART_MS
}

/**
 * The reconciliation state a gap restart (or the initial backfill) writes in
 * the hot pass's final page transaction: a new pass from the lower edge of the
 * hot window, with completion cleared so no day reads as covered until the
 * cursor passes it.
 */
export function gapRestartPassV1(startedAt: Date): ReconciliationPassV1 {
    return {
        passStartedAt: startedAt,
        floor: reconciliationFloorV1(startedAt),
        cursor: at(startedAt.getTime() - W.HOT_LOOKBACK_MS),
        completedAt: null,
    }
}

export type ReconciliationPlanV1 =
    | { due: false; reason: 'not_started' | 'not_due' }
    | { due: true; kind: 'continue' | 'regular_start'; pass: ReconciliationPassV1 & { passStartedAt: Date; floor: Date; cursor: Date } }

/**
 * Whether reconciliation has work now.
 *
 * A pass in progress continues. A complete pass is followed by a regular pass
 * once 6 h have passed since it started, start to start. In write mode a park
 * that never started waits for its first hot pass, whose gap rule starts the
 * initial backfill; a dry run starts its first pass immediately.
 */
export function planReconciliationV1(
    pass: ReconciliationPassV1,
    dbNow: Date,
    options: { horizon: 'claim' | 'dry_run' },
): ReconciliationPlanV1 {
    const floorFor = (now: Date) => (options.horizon === 'claim' ? reconciliationFloorV1(now) : dryRunReconciliationFloorV1(now))
    const regularStart = (): ReconciliationPlanV1 => ({
        due: true,
        kind: 'regular_start',
        pass: {
            passStartedAt: dbNow,
            floor: floorFor(dbNow),
            cursor: at(dbNow.getTime() - W.HOT_LOOKBACK_MS),
            // A regular pass keeps the previous completion, so every day stays
            // covered while it runs.
            completedAt: pass.completedAt,
        },
    })
    const state = reconciliationPassStateV1(pass)
    if (state === 'not_started') {
        return options.horizon === 'dry_run' ? regularStart() : { due: false, reason: 'not_started' }
    }
    if (state === 'in_progress') {
        if (pass.floor === null || pass.cursor === null) return regularStart()
        return {
            due: true,
            kind: 'continue',
            pass: { passStartedAt: pass.passStartedAt as Date, floor: pass.floor, cursor: pass.cursor, completedAt: pass.completedAt },
        }
    }
    const sinceStart = dbNow.getTime() - (pass.passStartedAt as Date).getTime()
    return sinceStart >= W.RECONCILIATION_PERIOD_MS ? regularStart() : { due: false, reason: 'not_due' }
}

/** The next 6 h slice below the cursor, newest first; null once the floor is reached. */
export function nextReconciliationSliceV1(cursor: Date, floor: Date): BookingWindowV1 | null {
    if (cursor.getTime() <= floor.getTime()) return null
    return { from: at(Math.max(floor.getTime(), cursor.getTime() - W.SLICE_MS)), to: cursor }
}

/**
 * The pass state a completed slice commits. Completion is stamped with the
 * slice's own database time, which is never earlier than the pass start.
 */
export function passAfterSliceV1(
    pass: ReconciliationPassV1 & { passStartedAt: Date; floor: Date },
    slice: BookingWindowV1,
    sliceStartedAt: Date,
): ReconciliationPassV1 {
    const reachedFloor = slice.from.getTime() <= pass.floor.getTime()
    return {
        passStartedAt: pass.passStartedAt,
        floor: pass.floor,
        cursor: slice.from,
        completedAt: reachedFloor ? sliceStartedAt : pass.completedAt,
    }
}

export function withReconciliationPassV1(
    progress: CashOrderIngestionProgressV1,
    pass: ReconciliationPassV1,
): CashOrderIngestionProgressV1 {
    return {
        lastHotSuccessAt: progress.lastHotSuccessAt,
        reconciliationPassStartedAt: pass.passStartedAt,
        reconciliationFloorBookedAt: pass.floor,
        reconciliationCursorBookedAt: pass.cursor,
        lastReconciliationCompletedAt: pass.completedAt,
    }
}

/**
 * A business day is covered when a reconciliation pass has completed, or the
 * cursor of the pass in progress is at least 24 h below the day's start.
 */
export function cashOrderDayCoveredV1(progress: CashOrderIngestionProgressV1, dayStart: Date): boolean {
    if (progress.lastReconciliationCompletedAt !== null) return true
    const cursor = progress.reconciliationCursorBookedAt
    return cursor !== null && cursor.getTime() <= dayStart.getTime() - W.BOOKING_MARGIN_MS
}

/** Completeness alarms. Write mode only; they never change a threshold. */
export function reconciliationAlarmsV1(pass: ReconciliationPassV1, dbNow: Date): string[] {
    const alarms: string[] = []
    const now = dbNow.getTime()
    if (reconciliationPassStateV1(pass) === 'in_progress' && pass.passStartedAt !== null
        && now - pass.passStartedAt.getTime() > W.PASS_IN_PROGRESS_ALARM_MS) {
        alarms.push('reconciliation_pass_overdue')
    }
    if (pass.completedAt !== null && now - pass.completedAt.getTime() > W.COMPLETION_AGE_ALARM_MS) {
        alarms.push('reconciliation_completion_stale')
    }
    return alarms
}

/** Write mode only: the park has had no successful hot pass for over 10 min. */
export function hotAgeExceededV1(lastHotSuccessAt: Date | null, dbNow: Date): boolean {
    return lastHotSuccessAt === null || dbNow.getTime() - lastHotSuccessAt.getTime() > W.HOT_AGE_ALARM_MS
}

export function businessDayStartV1(dayKey: string): Date {
    return compensationDayStartInstantV1(parseCompensationBusinessDayKeyV1(dayKey))
}

/**
 * The fallback window of a day confirmation, W(D):
 * [start(D) − 24 h, min(end(D) + 30 min, now + 10 min)]. Null for a day whose
 * window has not opened yet.
 */
export function targetedDayWindowV1(dayKey: string, dbNow: Date): BookingWindowV1 | null {
    const day = parseCompensationBusinessDayKeyV1(dayKey)
    const from = compensationDayStartInstantV1(day).getTime() - W.BOOKING_MARGIN_MS
    const to = Math.min(
        compensationDayEndInstantV1(day).getTime() + W.DAY_UPPER_MARGIN_MS,
        dbNow.getTime() + W.BOOKING_LOOKAHEAD_MS,
    )
    return to > from ? { from: at(from), to: at(to) } : null
}

/** Whether a day confirmation lies inside the reconciled claim horizon. */
export function targetedDayWithinHorizonV1(dayKey: string, dbNow: Date): boolean {
    return businessDayStartV1(dayKey).getTime() - W.BOOKING_MARGIN_MS >= reconciliationFloorV1(dbNow).getTime()
}

/** The narrow window around a stored booking time. */
export function narrowBookingWindowV1(providerBookedAt: Date): BookingWindowV1 {
    return {
        from: at(providerBookedAt.getTime() - W.NARROW_HALF_WIDTH_MS),
        to: at(providerBookedAt.getTime() + W.NARROW_HALF_WIDTH_MS),
    }
}

/** Merges overlapping or touching ranges. */
export function mergeBookingWindowsV1(ranges: readonly BookingWindowV1[]): BookingWindowV1[] {
    const sorted = [...ranges].sort((left, right) => left.from.getTime() - right.from.getTime())
    const merged: BookingWindowV1[] = []
    for (const range of sorted) {
        const last = merged[merged.length - 1]
        if (last && range.from.getTime() <= last.to.getTime()) {
            if (range.to.getTime() > last.to.getTime()) last.to = range.to
        } else {
            merged.push({ from: range.from, to: range.to })
        }
    }
    return merged
}

/**
 * The newest uncovered 6 h slice of a window, or null once the covered ranges
 * span it. Ranges already covered are never fetched again.
 */
export function nextUncoveredSliceV1(
    window: BookingWindowV1,
    covered: readonly BookingWindowV1[],
    widthMs: number = W.SLICE_MS,
): BookingWindowV1 | null {
    const ranges = mergeBookingWindowsV1(covered)
    let upper = window.to.getTime()
    for (let index = ranges.length - 1; index >= 0; index -= 1) {
        const range = ranges[index]
        if (range.from.getTime() < upper && range.to.getTime() >= upper) upper = range.from.getTime()
    }
    const lowerBound = window.from.getTime()
    if (upper <= lowerBound) return null
    const coveredBelow = ranges
        .map((range) => range.to.getTime())
        .filter((end) => end < upper)
    const lower = Math.max(lowerBound, upper - widthMs, ...coveredBelow)
    return { from: at(lower), to: at(upper) }
}
