import { describe, expect, it } from 'vitest'

import {
    projectCashOrderPageV1,
    projectCashOrderV1,
    type CashOrderRequestContextV1,
} from './compensation-cash-order-projection'

const CONTEXT: CashOrderRequestContextV1 = {
    provider: 'yandex_fleet',
    externalParkId: 'park-1',
    apiConnectionId: 'conn-1',
    observedAt: new Date('2026-09-13T15:30:00.000Z'),
}

/** Shaped exactly like a live completed order from the Fleet API. */
function order(overrides: Record<string, unknown> = {}) {
    return {
        id: 'a'.repeat(32),
        short_id: 3982091,
        status: 'complete',
        payment_method: 'cash',
        price: '335.0000',
        ended_at: '2026-09-13T15:24:59.982+00:00',
        booked_at: '2026-09-13T15:25:48.753+00:00',
        driver_profile: { id: 'b'.repeat(32), name: 'should never be read' },
        ...overrides,
    }
}

describe('accepting a completed cash order', () => {
    it('projects the five authoritative fields and stamps the park from context', () => {
        const result = projectCashOrderV1(order(), CONTEXT)
        expect(result.accepted).toBe(true)
        if (!result.accepted) return
        expect(result.order).toMatchObject({
            provider: 'yandex_fleet',
            externalParkId: 'park-1',
            apiConnectionId: 'conn-1',
            externalOrderId: 'a'.repeat(32),
            shortOrderIdDisplay: '3982091',
            externalDriverProfileId: 'b'.repeat(32),
            rawPrice: '335.0000',
            amountKopecks: 33500,
        })
        expect(result.order.endedAt.toISOString()).toBe('2026-09-13T15:24:59.982Z')
    })

    it('keeps the provider price string verbatim as evidence', () => {
        const result = projectCashOrderV1(order({ price: '1234.5678' }), CONTEXT)
        expect(result.accepted && result.order.rawPrice).toBe('1234.5678')
        // Truncating toward zero is the monetary core's rule, not ours.
        expect(result.accepted && result.order.amountKopecks).toBe(123456)
    })

    it('carries nothing from the payload beyond the named fields', () => {
        const result = projectCashOrderV1(order({ secret_token: 'nope', error: { body: 'upstream' } }), CONTEXT)
        expect(result.accepted).toBe(true)
        if (!result.accepted) return
        expect(Object.keys(result.order).sort()).toEqual([
            'amountKopecks', 'apiConnectionId', 'endedAt', 'externalDriverProfileId',
            'externalOrderId', 'externalParkId', 'observedAt', 'provider',
            'rawPrice', 'shortOrderIdDisplay',
        ])
    })

    it('never reads the park from the payload', () => {
        const result = projectCashOrderV1(order({ park_id: 'attacker-park' }), CONTEXT)
        expect(result.accepted && result.order.externalParkId).toBe('park-1')
    })
})

describe('rejecting everything that is not a completed cash order', () => {
    it('rejects a running order, whose payment method is still null', () => {
        const running = order({ status: 'driving', payment_method: null, price: null, ended_at: null })
        expect(projectCashOrderV1(running, CONTEXT)).toMatchObject({ accepted: false, reason: 'not_completed' })
    })

    it('rejects a cancelled order even when it carries a cash marker', () => {
        const cancelled = order({ status: 'cancelled', payment_method: 'cash', price: '0.0000' })
        expect(projectCashOrderV1(cancelled, CONTEXT)).toMatchObject({ accepted: false, reason: 'not_completed' })
    })

    it('rejects a completed cashless order', () => {
        expect(projectCashOrderV1(order({ payment_method: 'cashless' }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'not_cash' })
    })

    it('rejects a completed order whose payment method is missing', () => {
        expect(projectCashOrderV1(order({ payment_method: null }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'payment_method_missing' })
    })

    it('rejects an order with no completion instant', () => {
        expect(projectCashOrderV1(order({ ended_at: null }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'ended_at_missing' })
    })

    it('rejects an unparseable completion instant', () => {
        expect(projectCashOrderV1(order({ ended_at: 'not-a-date' }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'ended_at_invalid' })
    })

    it('rejects a price the monetary parser refuses', () => {
        expect(projectCashOrderV1(order({ price: '335.00' }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'price_unparseable' })
        expect(projectCashOrderV1(order({ price: '99999999.0000' }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'price_unparseable' })
    })

    it('rejects an order with no driver profile', () => {
        expect(projectCashOrderV1(order({ driver_profile: {} }), CONTEXT))
            .toMatchObject({ accepted: false, reason: 'driver_profile_missing' })
    })

    it('rejects an order with no id, and names no id back', () => {
        expect(projectCashOrderV1(order({ id: null }), CONTEXT))
            .toEqual({ accepted: false, reason: 'order_id_missing', externalOrderId: null })
    })

    it('rejects a non-object payload rather than throwing', () => {
        expect(projectCashOrderV1(null, CONTEXT)).toMatchObject({ accepted: false, reason: 'order_id_missing' })
    })
})

describe('projecting a page', () => {
    it('keeps only the completed cash orders and explains every rejection', () => {
        const page = projectCashOrderPageV1([
            order({ id: 'c'.repeat(32) }),
            order({ id: 'd'.repeat(32), status: 'driving', payment_method: null }),
            order({ id: 'e'.repeat(32), payment_method: 'cashless' }),
            order({ id: 'f'.repeat(32), status: 'cancelled', payment_method: 'cash' }),
        ], CONTEXT)

        expect(page.accepted.map((o) => o.externalOrderId)).toEqual(['c'.repeat(32)])
        expect(page.rejected.map((r) => r.reason)).toEqual(['not_completed', 'not_cash', 'not_completed'])
    })

    it('returns empty results for an empty page', () => {
        expect(projectCashOrderPageV1([], CONTEXT)).toEqual({ accepted: [], rejected: [] })
    })
})
