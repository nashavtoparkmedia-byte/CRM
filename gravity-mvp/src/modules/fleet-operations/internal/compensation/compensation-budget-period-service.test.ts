import { describe, expect, it, vi } from 'vitest'

import {
    compensationBudgetPeriodIdV1,
    compensationBudgetPeriodWindowV1,
    type CompensationBudgetPeriodRowV1,
} from './compensation-budget-period'
import {
    ensureCompensationBudgetPeriodV1,
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
