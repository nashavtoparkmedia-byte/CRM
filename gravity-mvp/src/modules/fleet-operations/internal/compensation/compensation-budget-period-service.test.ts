import { describe, expect, it, vi } from 'vitest'

import {
    compensationBudgetPeriodIdV1,
    compensationBudgetPeriodWindowV1,
    type CompensationBudgetPeriodRowV1,
} from './compensation-budget-period'
import {
    ensureCompensationBudgetPeriodV1,
    provisionCompensationBudgetPeriodsV1,
    type CompensationBudgetPeriodPortV1,
} from './compensation-budget-period-service'

/**
 * The provisioning seam against a fake store.
 *
 * What matters here is the wiring: which decision reaches storage, what a dry
 * run refuses to do, and that the answer always states the month storage holds.
 */

const row = (over: Partial<CompensationBudgetPeriodRowV1> = {}): CompensationBudgetPeriodRowV1 => ({
    id: compensationBudgetPeriodIdV1('2026-09'),
    periodKey: '2026-09',
    state: 'open',
    limitKopecks: 500_000,
    reservedKopecks: 0,
    settledKopecks: 0,
    ...over,
})

/** Storage answers what the caller says it answers; the seam only wires it. */
function fakePort(
    existing: CompensationBudgetPeriodRowV1 | null,
    stored?: CompensationBudgetPeriodRowV1,
    outcome: 'created' | 'already_configured' | 'limit_increased' =
        existing === null ? 'created' : 'already_configured',
) {
    type Port = CompensationBudgetPeriodPortV1
    return {
        findPeriod: vi.fn<Port['findPeriod']>(async () => existing),
        provisionPeriod: vi.fn<Port['provisionPeriod']>(async () => ({
            ok: true as const,
            outcome,
            row: stored ?? row(),
        })),
    } satisfies CompensationBudgetPeriodPortV1
}

describe('opening a month', () => {
    it('creates one that does not exist, with the derived window', async () => {
        const port = fakePort(null, row({ limitKopecks: 500_000 }))
        const result = await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 500_000 }, port)

        expect(result).toMatchObject({ ok: true, dryRun: false, outcome: 'created', refusal: null })
        expect(result.period).toMatchObject({ periodKey: '2026-09', limitKopecks: 500_000, remainingKopecks: 500_000 })
        expect(port.provisionPeriod).toHaveBeenCalledWith({
            window: compensationBudgetPeriodWindowV1('2026-09'),
            id: compensationBudgetPeriodIdV1('2026-09'),
            limitKopecks: 500_000,
        })
    })

    it('reports an unchanged month as already configured without writing', async () => {
        const port = fakePort(row())
        const result = await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 500_000 }, port)
        expect(result).toMatchObject({ ok: true, outcome: 'already_configured' })
        // The port is still asked, because storage decides under its own lock.
        expect(port.provisionPeriod).toHaveBeenCalledWith(expect.objectContaining({ limitKopecks: 500_000 }))
    })

    it('carries a raise to storage', async () => {
        const port = fakePort(row(), row({ limitKopecks: 700_000 }), 'limit_increased')
        const result = await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 700_000 }, port)
        expect(result).toMatchObject({ ok: true, outcome: 'limit_increased' })
        expect(result.period).toMatchObject({ limitKopecks: 700_000 })
    })
})

describe('what it refuses before touching storage', () => {
    it('refuses an unusable period key without even reading', async () => {
        const port = fakePort(null)
        expect(await ensureCompensationBudgetPeriodV1({ periodKey: '2026-13', limitKopecks: 500_000 }, port))
            .toEqual({ ok: false, dryRun: false, outcome: null, refusal: 'invalid_period_key', period: null })
        expect(port.findPeriod).not.toHaveBeenCalled()
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('refuses an unusable limit without writing', async () => {
        const port = fakePort(null)
        expect(await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 0 }, port))
            .toMatchObject({ ok: false, refusal: 'invalid_limit' })
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('refuses to lower a limit, and shows the month as it stands', async () => {
        const port = fakePort(row({ reservedKopecks: 30_000 }))
        const result = await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 100_000 }, port)
        expect(result).toMatchObject({ ok: false, refusal: 'limit_below_configured' })
        expect(result.period).toMatchObject({ limitKopecks: 500_000, reservedKopecks: 30_000, remainingKopecks: 470_000 })
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('refuses to reopen a closed month', async () => {
        const port = fakePort(row({ state: 'closed' }))
        expect(await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 900_000 }, port))
            .toMatchObject({ ok: false, refusal: 'period_not_open' })
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('passes a storage refusal back as it was decided under the lock', async () => {
        const port = fakePort(null)
        port.provisionPeriod.mockResolvedValue({ ok: false, refusal: 'period_not_open', row: row({ state: 'closed' }) })
        const result = await ensureCompensationBudgetPeriodV1({ periodKey: '2026-09', limitKopecks: 500_000 }, port)
        expect(result).toMatchObject({ ok: false, refusal: 'period_not_open' })
        expect(result.period).toMatchObject({ state: 'closed' })
    })
})

describe('a dry run', () => {
    it('plans the creation and writes nothing', async () => {
        const port = fakePort(null)
        const result = await ensureCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 500_000, dryRun: true }, port,
        )
        expect(result).toEqual({ ok: true, dryRun: true, outcome: 'created', refusal: null, period: null })
        expect(port.findPeriod).toHaveBeenCalledWith('2026-09')
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('plans a raise and shows the month it would raise', async () => {
        const port = fakePort(row())
        const result = await ensureCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 700_000, dryRun: true }, port,
        )
        expect(result).toMatchObject({ ok: true, dryRun: true, outcome: 'limit_increased' })
        expect(result.period).toMatchObject({ limitKopecks: 500_000 })
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('still refuses what a real run would refuse', async () => {
        const port = fakePort(row({ state: 'closed' }))
        expect(await ensureCompensationBudgetPeriodV1(
            { periodKey: '2026-09', limitKopecks: 900_000, dryRun: true }, port,
        )).toMatchObject({ ok: false, dryRun: true, refusal: 'period_not_open' })
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })
})

/** A store holding several months; it creates what it is asked to create and records every write. */
function monthsPort(stored: CompensationBudgetPeriodRowV1[], failOn: string[] = []) {
    type Port = CompensationBudgetPeriodPortV1
    const months = new Map(stored.map((month) => [month.periodKey, month]))
    const port = {
        findPeriod: vi.fn<Port['findPeriod']>(async (periodKey) => {
            if (failOn.includes(periodKey)) throw new Error(`storage unavailable for ${periodKey}`)
            return months.get(periodKey) ?? null
        }),
        provisionPeriod: vi.fn<Port['provisionPeriod']>(async ({ window, id, limitKopecks, createOnly }) => {
            const existing = months.get(window.periodKey)
            if (existing !== undefined) {
                // A month that appeared after the caller's read: create-only leaves it.
                expect(createOnly).toBe(true)
                return { ok: true as const, outcome: 'already_configured' as const, row: existing }
            }
            const created = { id, periodKey: window.periodKey, state: 'open', limitKopecks, reservedKopecks: 0, settledKopecks: 0 }
            months.set(window.periodKey, created)
            return { ok: true as const, outcome: 'created' as const, row: created }
        }),
    } satisfies CompensationBudgetPeriodPortV1
    return Object.assign(port, { months })
}

const OCTOBER = row({ id: compensationBudgetPeriodIdV1('2026-10'), periodKey: '2026-10', reservedKopecks: 40_000, settledKopecks: 10_000 })
const LATE_OCTOBER = new Date('2026-10-31T10:30:00Z')

describe('scheduled provisioning', () => {
    it('opens the next month ahead of time and leaves the current one exactly as stored', async () => {
        const port = monthsPort([OCTOBER])
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)

        expect(run.ok).toBe(true)
        expect(run.months.map((month) => [month.periodKey, month.status])).toEqual([['2026-10', 'present'], ['2026-11', 'created']])
        expect(port.provisionPeriod).toHaveBeenCalledTimes(1)
        expect(port.provisionPeriod).toHaveBeenCalledWith({
            window: compensationBudgetPeriodWindowV1('2026-11'),
            id: compensationBudgetPeriodIdV1('2026-11'),
            limitKopecks: 500_000,
            createOnly: true,
        })
        expect(port.months.get('2026-10')).toEqual(OCTOBER)
    })

    it('never raises a stored month to the configured limit, and says that it differs', async () => {
        const low = row({ id: compensationBudgetPeriodIdV1('2026-11'), periodKey: '2026-11', limitKopecks: 300_000 })
        const port = monthsPort([OCTOBER, low])
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)

        expect(run.ok).toBe(true)
        expect(run.months[1]).toMatchObject({ periodKey: '2026-11', status: 'present', limitKopecks: 300_000, limitDiffersFromConfiguration: true })
        // A stored month is not even locked: nothing reaches the write path.
        expect(port.provisionPeriod).not.toHaveBeenCalled()
        expect(port.months.get('2026-11')).toEqual(low)
    })

    it('leaves a closed month closed and reports its state', async () => {
        const closed = row({ id: compensationBudgetPeriodIdV1('2026-10'), periodKey: '2026-10', state: 'closed' })
        const port = monthsPort([closed])
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)

        expect(run.months[0]).toMatchObject({ periodKey: '2026-10', status: 'present', state: 'closed' })
        expect(port.months.get('2026-10')).toEqual(closed)
    })

    it('writes nothing without a configured limit and reports every missing month', async () => {
        const port = monthsPort([OCTOBER])
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: null }, port)

        expect(run).toMatchObject({ ok: false, configuredLimitKopecks: null })
        expect(run.months.map((month) => [month.periodKey, month.status])).toEqual([['2026-10', 'present'], ['2026-11', 'missing_unconfigured']])
        expect(port.provisionPeriod).not.toHaveBeenCalled()
    })

    it('keeps going past a failed month and reports it, so the next run retries', async () => {
        const port = monthsPort([], ['2026-10'])
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)

        expect(run.ok).toBe(false)
        expect(run.months[0]).toMatchObject({ periodKey: '2026-10', status: 'failed', error: 'storage unavailable for 2026-10' })
        expect(run.months[1]).toMatchObject({ periodKey: '2026-11', status: 'created' })

        // The retry, once storage answers again, opens what the failed run missed.
        const retry = monthsPort([...port.months.values()])
        const again = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, retry)
        expect(again.months.map((month) => [month.periodKey, month.status])).toEqual([['2026-10', 'created'], ['2026-11', 'present']])
    })

    it('is idempotent across repeated runs', async () => {
        const port = monthsPort([OCTOBER])
        await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)
        const snapshot = new Map(port.months)
        const second = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)

        expect(second.months.map((month) => month.status)).toEqual(['present', 'present'])
        expect(port.provisionPeriod).toHaveBeenCalledTimes(1)
        expect(port.months).toEqual(snapshot)
    })

    it('treats a month another run created in between as present, never as a second month', async () => {
        const port = monthsPort([OCTOBER])
        const november = row({ id: compensationBudgetPeriodIdV1('2026-11'), periodKey: '2026-11' })
        // The read sees no November; by the time the write path runs, another process opened it.
        port.findPeriod.mockImplementationOnce(async () => OCTOBER).mockImplementationOnce(async () => {
            port.months.set('2026-11', november)
            return null
        })
        const run = await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 700_000 }, port)

        expect(run.months[1]).toMatchObject({ periodKey: '2026-11', status: 'present', limitKopecks: 500_000, limitDiffersFromConfiguration: true })
        expect(port.months.get('2026-11')).toEqual(november)
    })

    it('does not reach October once November has started, even inside October\'s 72-hour grace', async () => {
        const port = monthsPort([OCTOBER])
        await provisionCompensationBudgetPeriodsV1({ now: new Date('2026-11-02T10:00:00Z'), limitKopecks: 500_000 }, port)

        expect(port.findPeriod.mock.calls.map(([key]) => key)).toEqual(['2026-11', '2026-12'])
        expect(port.months.get('2026-10')).toEqual(OCTOBER)
    })

    it('opens the months after a configuration change at the new limit and leaves earlier ones at theirs', async () => {
        const port = monthsPort([OCTOBER])
        await provisionCompensationBudgetPeriodsV1({ now: LATE_OCTOBER, limitKopecks: 500_000 }, port)
        const run = await provisionCompensationBudgetPeriodsV1({ now: new Date('2026-11-15T10:00:00Z'), limitKopecks: 700_000 }, port)

        expect(run.months).toMatchObject([
            { periodKey: '2026-11', status: 'present', limitKopecks: 500_000, limitDiffersFromConfiguration: true },
            { periodKey: '2026-12', status: 'created', limitKopecks: 700_000, limitDiffersFromConfiguration: false },
        ])
    })
})
