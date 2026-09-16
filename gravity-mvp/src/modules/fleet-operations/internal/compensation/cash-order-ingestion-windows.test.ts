import { describe, expect, it } from 'vitest'

import { CashOrderBudgetV1, CASH_ORDER_INGESTION_TIMING_V1 as T } from './cash-order-ingestion-budget'
import {
    parseCashOrderIngestionConfigV1,
    parseCashOrderIngestionModeV1,
} from './cash-order-ingestion-config'
import {
    businessDayStartV1,
    cashOrderDayCoveredV1,
    dryRunReconciliationFloorV1,
    gapRestartPassV1,
    gapRestartRequiredV1,
    hotAgeExceededV1,
    hotWindowV1,
    narrowBookingWindowV1,
    nextReconciliationSliceV1,
    nextUncoveredSliceV1,
    passAfterSliceV1,
    planReconciliationV1,
    reconciliationAlarmsV1,
    reconciliationFloorV1,
    reconciliationPassStateV1,
    targetedDayWindowV1,
    targetedDayWithinHorizonV1,
    type ReconciliationPassV1,
} from './cash-order-ingestion-windows'
import { CashOrderParkTenureQueueV1 } from './cash-order-park-tenure-queue'

const d = (iso: string) => new Date(iso)
const H = 3_600_000
const M = 60_000

describe('hot window', () => {
    it('spans three hours back and ten minutes ahead of the pass start', () => {
        expect(hotWindowV1(d('2026-09-16T09:00:00.000Z'))).toEqual({
            from: d('2026-09-16T06:00:00.000Z'),
            to: d('2026-09-16T09:10:00.000Z'),
        })
    })
})

describe('reconciliation floor', () => {
    it('is the Yekaterinburg month start less the 24 h margin mid-month', () => {
        // 1 Sep 00:00 in Yekaterinburg is 31 Aug 19:00 UTC.
        expect(reconciliationFloorV1(d('2026-09-16T09:00:00.000Z'))).toEqual(d('2026-08-30T19:00:00.000Z'))
    })

    it('reaches 72 h back into the previous month early in a month', () => {
        const now = d('2026-09-02T09:00:00.000Z')
        expect(reconciliationFloorV1(now)).toEqual(new Date(now.getTime() - 72 * H - 24 * H))
    })

    it('switches month at Yekaterinburg midnight, not UTC midnight', () => {
        // 18:59 UTC on 30 Sep is still September in Yekaterinburg.
        const lateSeptember = d('2026-09-30T18:59:00.000Z')
        expect(reconciliationFloorV1(lateSeptember)).toEqual(d('2026-08-30T19:00:00.000Z'))
        // One minute later it is 1 Oct locally: the floor becomes now − 72 h − 24 h.
        const october = d('2026-09-30T19:00:00.000Z')
        expect(reconciliationFloorV1(october)).toEqual(new Date(october.getTime() - 96 * H))
    })

    it('keeps a last-day order reconciled until its 72 h grace deadline', () => {
        // Ended 30 Sep 22:00 local, booked a day before its end at the latest.
        const endedAt = d('2026-09-30T17:00:00.000Z')
        const bookedAt = new Date(endedAt.getTime() - 24 * H)
        const deadline = new Date(endedAt.getTime() + 72 * H)
        expect(reconciliationFloorV1(deadline).getTime()).toBeLessThanOrEqual(bookedAt.getTime())
        expect(reconciliationFloorV1(new Date(deadline.getTime() + H)).getTime()).toBeGreaterThan(bookedAt.getTime())
    })

    it('measures dry runs over a fixed 31-day horizon', () => {
        const now = d('2026-09-16T09:00:00.000Z')
        expect(dryRunReconciliationFloorV1(now)).toEqual(new Date(now.getTime() - 31 * 24 * H - 24 * H))
    })
})

describe('reconciliation pass state and cadence', () => {
    const now = d('2026-09-16T12:00:00.000Z')
    const pass = (overrides: Partial<ReconciliationPassV1>): ReconciliationPassV1 => ({
        passStartedAt: null, floor: null, cursor: null, completedAt: null, ...overrides,
    })

    it('reads not started, in progress and complete', () => {
        expect(reconciliationPassStateV1(pass({}))).toBe('not_started')
        expect(reconciliationPassStateV1(pass({ passStartedAt: now }))).toBe('in_progress')
        expect(reconciliationPassStateV1(pass({ passStartedAt: now, completedAt: new Date(now.getTime() - 1) }))).toBe('in_progress')
        expect(reconciliationPassStateV1(pass({ passStartedAt: now, completedAt: now }))).toBe('complete')
    })

    it('waits for the first hot pass in write mode but starts a dry run immediately', () => {
        expect(planReconciliationV1(pass({}), now, { horizon: 'claim' })).toEqual({ due: false, reason: 'not_started' })
        expect(planReconciliationV1(pass({}), now, { horizon: 'dry_run' })).toMatchObject({ due: true, kind: 'regular_start' })
    })

    it('continues a pass in progress from its cursor', () => {
        const inProgress = pass({ passStartedAt: d('2026-09-16T10:00:00.000Z'), floor: d('2026-08-30T19:00:00.000Z'), cursor: d('2026-09-10T00:00:00.000Z') })
        expect(planReconciliationV1(inProgress, now, { horizon: 'claim' })).toEqual({ due: true, kind: 'continue', pass: inProgress })
    })

    it('starts a regular pass exactly 6 h after the previous start, not 1 ms earlier', () => {
        const start = d('2026-09-16T06:00:00.000Z')
        const complete = pass({ passStartedAt: start, floor: d('2026-08-30T19:00:00.000Z'), cursor: d('2026-08-30T19:00:00.000Z'), completedAt: d('2026-09-16T06:40:00.000Z') })
        expect(planReconciliationV1(complete, new Date(start.getTime() + 6 * H - 1), { horizon: 'claim' })).toEqual({ due: false, reason: 'not_due' })
        const due = planReconciliationV1(complete, new Date(start.getTime() + 6 * H), { horizon: 'claim' })
        expect(due).toMatchObject({ due: true, kind: 'regular_start' })
        // A regular pass keeps the previous completion, so no day stops being covered.
        if (due.due) expect(due.pass.completedAt).toEqual(complete.completedAt)
    })

    it('restarts after a 30 min hot gap and on the initial backfill', () => {
        const S = d('2026-09-16T12:00:00.000Z')
        expect(gapRestartRequiredV1(null, S)).toBe(true)
        expect(gapRestartRequiredV1(new Date(S.getTime() - 30 * M), S)).toBe(false)
        expect(gapRestartRequiredV1(new Date(S.getTime() - 30 * M - 1), S)).toBe(true)
        expect(gapRestartPassV1(S)).toEqual({
            passStartedAt: S,
            floor: reconciliationFloorV1(S),
            cursor: d('2026-09-16T09:00:00.000Z'),
            completedAt: null,
        })
    })

    it('walks 6 h slices newest first down to the floor and completes there', () => {
        const floor = d('2026-09-15T00:00:00.000Z')
        expect(nextReconciliationSliceV1(d('2026-09-16T09:00:00.000Z'), floor))
            .toEqual({ from: d('2026-09-16T03:00:00.000Z'), to: d('2026-09-16T09:00:00.000Z') })
        expect(nextReconciliationSliceV1(d('2026-09-15T04:00:00.000Z'), floor))
            .toEqual({ from: floor, to: d('2026-09-15T04:00:00.000Z') })
        expect(nextReconciliationSliceV1(floor, floor)).toBeNull()

        const inProgress = { passStartedAt: d('2026-09-16T12:00:00.000Z'), floor, cursor: d('2026-09-15T04:00:00.000Z'), completedAt: null }
        const sliceStart = d('2026-09-16T13:00:00.000Z')
        expect(passAfterSliceV1(inProgress, { from: floor, to: inProgress.cursor }, sliceStart))
            .toEqual({ ...inProgress, cursor: floor, completedAt: sliceStart })
        expect(passAfterSliceV1(inProgress, { from: d('2026-09-15T02:00:00.000Z'), to: inProgress.cursor }, sliceStart).completedAt).toBeNull()
    })

    it('covers a day once completed, or once the cursor is 24 h below its start', () => {
        const dayStart = businessDayStartV1('2026-09-15')
        const progress = {
            lastHotSuccessAt: now,
            reconciliationPassStartedAt: now,
            reconciliationFloorBookedAt: d('2026-08-30T19:00:00.000Z'),
            reconciliationCursorBookedAt: new Date(dayStart.getTime() - 24 * H + 1),
            lastReconciliationCompletedAt: null,
        }
        expect(cashOrderDayCoveredV1(progress, dayStart)).toBe(false)
        expect(cashOrderDayCoveredV1({ ...progress, reconciliationCursorBookedAt: new Date(dayStart.getTime() - 24 * H) }, dayStart)).toBe(true)
        expect(cashOrderDayCoveredV1({ ...progress, lastReconciliationCompletedAt: d('2026-09-16T01:00:00.000Z') }, dayStart)).toBe(true)
    })

    it('raises the in-progress alarm after 3 h and the completion alarm after 12 h, never at the boundary', () => {
        const start = d('2026-09-16T00:00:00.000Z')
        const inProgress = pass({ passStartedAt: start, completedAt: null })
        expect(reconciliationAlarmsV1(inProgress, new Date(start.getTime() + 3 * H))).toEqual([])
        expect(reconciliationAlarmsV1(inProgress, new Date(start.getTime() + 3 * H + 1))).toEqual(['reconciliation_pass_overdue'])

        const completed = d('2026-09-16T01:00:00.000Z')
        const complete = pass({ passStartedAt: start, completedAt: completed })
        expect(reconciliationAlarmsV1(complete, new Date(completed.getTime() + 12 * H))).toEqual([])
        expect(reconciliationAlarmsV1(complete, new Date(completed.getTime() + 12 * H + 1))).toEqual(['reconciliation_completion_stale'])
        // A gap restart clears completion, which silences the 12 h alarm.
        expect(reconciliationAlarmsV1(pass({ passStartedAt: new Date(completed.getTime() + 13 * H) }), new Date(completed.getTime() + 13 * H))).toEqual([])
    })

    it('treats a hot age over 10 min, or no hot success at all, as exceeded', () => {
        expect(hotAgeExceededV1(null, now)).toBe(true)
        expect(hotAgeExceededV1(new Date(now.getTime() - 10 * M), now)).toBe(false)
        expect(hotAgeExceededV1(new Date(now.getTime() - 10 * M - 1), now)).toBe(true)
    })
})

describe('day confirmation windows', () => {
    it('opens the business day with a 24 h booking margin and a 30 min upper margin', () => {
        // 15 Sep in Yekaterinburg: 14 Sep 19:00 UTC to 15 Sep 19:00 UTC.
        expect(targetedDayWindowV1('2026-09-15', d('2026-09-20T00:00:00.000Z'))).toEqual({
            from: d('2026-09-13T19:00:00.000Z'),
            to: d('2026-09-15T19:30:00.000Z'),
        })
    })

    it('stops at now + 10 min for today', () => {
        expect(targetedDayWindowV1('2026-09-16', d('2026-09-16T09:00:00.000Z'))?.to).toEqual(d('2026-09-16T09:10:00.000Z'))
    })

    it('has no window for a day that has not opened', () => {
        expect(targetedDayWindowV1('2026-09-20', d('2026-09-16T09:00:00.000Z'))).toBeNull()
    })

    it('refuses days whose window reaches below the reconciliation floor', () => {
        const now = d('2026-09-16T09:00:00.000Z')
        expect(targetedDayWithinHorizonV1('2026-09-01', now)).toBe(true)
        expect(targetedDayWithinHorizonV1('2026-08-31', now)).toBe(false)
    })

    it('narrows to five minutes either side of the stored booking time', () => {
        expect(narrowBookingWindowV1(d('2026-09-16T08:25:00.000Z'))).toEqual({
            from: d('2026-09-16T08:20:00.000Z'),
            to: d('2026-09-16T08:30:00.000Z'),
        })
    })

    it('slices the fallback newest first and never refetches a covered range', () => {
        const window = { from: d('2026-09-13T19:00:00.000Z'), to: d('2026-09-15T19:30:00.000Z') }
        const first = nextUncoveredSliceV1(window, [])
        expect(first).toEqual({ from: d('2026-09-15T13:30:00.000Z'), to: window.to })
        const second = nextUncoveredSliceV1(window, [first!])
        expect(second).toEqual({ from: d('2026-09-15T07:30:00.000Z'), to: d('2026-09-15T13:30:00.000Z') })
        // A range covered further down is skipped, and the slice stops at it.
        const gapped = nextUncoveredSliceV1(window, [first!, { from: d('2026-09-15T00:00:00.000Z'), to: d('2026-09-15T10:00:00.000Z') }])
        expect(gapped).toEqual({ from: d('2026-09-15T10:00:00.000Z'), to: d('2026-09-15T13:30:00.000Z') })
        expect(nextUncoveredSliceV1(window, [window])).toBeNull()
    })
})

describe('run budget', () => {
    const clock = (start = 0) => {
        let now = start
        return { clock: { nowMs: () => now }, advance: (ms: number) => { now += ms } }
    }

    it('derives its floors from the write, finish, margin and minimum request', () => {
        expect(T.ADMISSION_FLOOR_MS).toBe(23_000)
        expect(T.PARK_START_FLOOR_MS).toBe(29_000)
    })

    it('admits a request at exactly the floor and cuts its timeout to fit', () => {
        const time = clock()
        const budget = CashOrderBudgetV1.fromNow(time.clock, 40_000)
        time.advance(17_000)
        expect(budget.admitsRequest()).toBe(true)
        expect(budget.requestTimeoutMs(10_000)).toBe(5_000)
        time.advance(1)
        expect(budget.admitsRequest()).toBe(false)
    })

    it('never lets a child budget outlive its parent', () => {
        const time = clock()
        const run = CashOrderBudgetV1.fromNow(time.clock, 110_000)
        time.advance(100_000)
        expect(run.child(40_000).remainingMs()).toBe(10_000)
    })
})

describe('ingestion mode and enabled parks', () => {
    it('defaults to off for an unset, empty or unknown mode', () => {
        for (const value of [undefined, '', '  ', 'WRITE', 'on', 'dry-run', 'true']) {
            expect(parseCashOrderIngestionModeV1(value)).toBe('off')
        }
        expect(parseCashOrderIngestionModeV1(' dry_run ')).toBe('dry_run')
        expect(parseCashOrderIngestionModeV1('write')).toBe('write')
    })

    it('reads a comma-separated park list without duplicates', () => {
        expect(parseCashOrderIngestionConfigV1({ mode: 'write', parks: ' ext-a, ext-b ,,ext-a' }))
            .toEqual({ mode: 'write', enabledParks: ['ext-a', 'ext-b'], configError: null })
        expect(parseCashOrderIngestionConfigV1({ mode: undefined, parks: undefined }))
            .toEqual({ mode: 'off', enabledParks: [], configError: null })
    })

    it('fails the configuration, rather than truncating, above three parks', () => {
        expect(parseCashOrderIngestionConfigV1({ mode: 'write', parks: 'a,b,c,d' }))
            .toMatchObject({ configError: 'enabled_park_limit_exceeded' })
    })
})

describe('park tenure queue', () => {
    const never = new Promise<void>(() => undefined)

    it('grants waiting targeted slices first in, first out, ahead of reconciliation', async () => {
        const queue = new CashOrderParkTenureQueueV1()
        const order: string[] = []
        const holder = await queue.acquire('targeted', never)
        const reconciliation = queue.acquire('reconciliation', never).then((release) => { order.push('reconciliation'); release?.() })
        const first = queue.acquire('targeted', never).then((release) => { order.push('targeted-1'); release?.() })
        const second = queue.acquire('targeted', never).then((release) => { order.push('targeted-2'); release?.() })
        holder?.()
        await Promise.all([reconciliation, first, second])
        expect(order).toEqual(['targeted-1', 'targeted-2', 'reconciliation'])
    })

    it('starts nothing else while a tick has a background hot pass pending', async () => {
        const queue = new CashOrderParkTenureQueueV1()
        queue.beginBackgroundHot()
        let targetedGranted = false
        const targeted = queue.acquire('targeted', never).then((release) => { targetedGranted = true; return release })
        await Promise.resolve()
        expect(targetedGranted).toBe(false)
        const hot = await queue.acquire('background_hot', never)
        expect(hot).not.toBeNull()
        hot?.()
        await Promise.resolve()
        expect(targetedGranted).toBe(false)
        queue.endBackgroundHot()
        ;(await targeted)?.()
        expect(targetedGranted).toBe(true)
    })

    it('drops an abandoned waiter without ever granting it', async () => {
        const queue = new CashOrderParkTenureQueueV1()
        const holder = await queue.acquire('reconciliation', never)
        let abandon!: () => void
        const abandoned = queue.acquire('targeted', new Promise<void>((resolve) => { abandon = resolve }))
        abandon()
        expect(await abandoned).toBeNull()
        holder?.()
        const next = await queue.acquire('reconciliation', never)
        expect(next).not.toBeNull()
    })
})
