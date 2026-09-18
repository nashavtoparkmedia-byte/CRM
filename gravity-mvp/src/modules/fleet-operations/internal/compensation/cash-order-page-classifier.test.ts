import { describe, expect, it } from 'vitest'

import { classifyCashOrderPageV1 } from './cash-order-page-classifier'
import type { CashOrderRequestContextV1 } from './compensation-cash-order-projection'

const CONTEXT: CashOrderRequestContextV1 = {
    provider: 'yandex_fleet',
    externalParkId: 'ext-yoko',
    apiConnectionId: 'conn-yoko',
    observedAt: new Date('2026-09-16T09:00:00.000Z'),
}

function order(id: string, overrides: Record<string, unknown> = {}) {
    return {
        id,
        short_id: 101,
        status: 'complete',
        payment_method: 'cash',
        price: '335.0000',
        ended_at: '2026-09-16T08:24:59.982+00:00',
        booked_at: '2026-09-16T08:25:48.753+00:00',
        driver_profile: { id: 'profile-1' },
        ...overrides,
    }
}

function decisions(raw: unknown[]) {
    const result = classifyCashOrderPageV1(raw, CONTEXT)
    if (!result.consistent) throw new Error('unexpected inconsistent page')
    return result.decisions
}

describe('page classification', () => {
    it('accepts a complete, cash, payable order', () => {
        const page = decisions([order('o1')])
        expect(page.accepted.map((row) => row.externalOrderId)).toEqual(['o1'])
        expect(page.removals).toEqual([])
    })

    it('removes an order whose status is explicitly not complete', () => {
        expect(decisions([order('o1', { status: 'cancelled' })]).removals)
            .toEqual([{ externalOrderId: 'o1', reason: 'not_completed' }])
        expect(decisions([order('o2', { status: 'driving', payment_method: null, price: null })]).removals)
            .toEqual([{ externalOrderId: 'o2', reason: 'not_completed' }])
    })

    it('removes a complete order whose payment method is explicitly not cash', () => {
        expect(decisions([order('o1', { payment_method: 'cashless' })]).removals)
            .toEqual([{ externalOrderId: 'o1', reason: 'not_cash' }])
    })

    it('removes an accepted order that pays zero kopecks', () => {
        const page = decisions([order('o1', { price: '0.0000' }), order('o2', { price: '0.0099' })])
        expect(page.accepted).toEqual([])
        expect(page.removals).toEqual([
            { externalOrderId: 'o1', reason: 'not_payable' },
            { externalOrderId: 'o2', reason: 'not_payable' },
        ])
    })

    it('never removes on a missing or null field', () => {
        const page = decisions([
            order('o1', { status: undefined }),
            order('o2', { status: null }),
            order('o3', { status: '  ' }),
            order('o4', { payment_method: null }),
            order('o5', { payment_method: '' }),
            order('o6', { price: undefined }),
            order('o7', { price: 'abc' }),
            order('o8', { ended_at: null }),
            order('o9', { driver_profile: null }),
            order('', {}),
            null,
            'not an object',
        ])
        expect(page.accepted).toEqual([])
        expect(page.removals).toEqual([])
        expect(page.ignoredByReason).toEqual({
            not_completed: 3,
            payment_method_missing: 2,
            price_missing: 1,
            price_unparseable: 1,
            ended_at_missing: 1,
            driver_profile_missing: 1,
            order_id_missing: 3,
        })
    })

    it('never removes a cashless order whose status is missing', () => {
        const page = decisions([order('o1', { status: null, payment_method: 'cashless' })])
        expect(page.removals).toEqual([])
        expect(page.ignoredByReason).toEqual({ not_completed: 1 })
    })

    it('does not let a malformed booked_at change a decision', () => {
        const page = decisions([order('o1', { booked_at: 'garbage' })])
        expect(page.accepted).toHaveLength(1)
        expect(page.accepted[0].providerBookedAt).toBeNull()
    })

    it('collapses identical copies of an order into one', () => {
        const page = decisions([order('o1'), order('o1'), order('o2', { status: 'cancelled' }), order('o2', { status: 'cancelled' })])
        expect(page.accepted).toHaveLength(1)
        expect(page.removals).toHaveLength(1)
        expect(page.collapsedDuplicates).toBe(2)
    })

    it('refuses the whole page when copies of one order disagree', () => {
        for (const conflicting of [
            [order('o1'), order('o1', { price: '400.0000' })],
            [order('o1'), order('o1', { status: 'cancelled' })],
            [order('o1'), order('o1', { payment_method: null })],
            [order('o1'), order('o1', { booked_at: '2026-09-16T08:30:00.000+00:00' })],
            [order('o1', { status: 'cancelled' }), order('o1', { payment_method: 'cashless' })],
        ]) {
            expect(classifyCashOrderPageV1(conflicting, CONTEXT))
                .toEqual({ consistent: false, code: 'provider_page_inconsistent', externalOrderId: 'o1' })
        }
    })

    it('treats an empty page as a valid page', () => {
        expect(decisions([])).toEqual({ accepted: [], removals: [], ignoredByReason: {}, collapsedDuplicates: 0 })
    })
})
