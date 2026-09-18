/**
 * Projection of a Yandex Fleet order into a verified cash order.
 *
 * The shape below is what the live Fleet API actually returns, confirmed
 * against a real park rather than taken from documentation. Only five fields
 * carry authority:
 *
 *   id                  the provider's order identity
 *   ended_at            the completion instant, which anchors the business month
 *   price               a string with exactly four decimals, e.g. "335.0000"
 *   payment_method      "cash" or "cashless", and null while the order runs
 *   driver_profile.id   the profile the order belongs to
 *
 * booked_at is also carried, as `providerBookedAt`, but it has no authority:
 * the provider filters orders by it, so it only lets a later confirmation ask
 * for this one order precisely. A missing or unparseable value is null and
 * never changes whether the order is accepted.
 *
 * The park is deliberately absent from the payload: orders are fetched per
 * park, so the park identity comes from the connection the request went
 * through and is stamped here. The monetary core's own port documents the
 * same thing.
 *
 * Everything is a rejection unless it is provably a completed cash order.
 * A running order has no payment method yet, so accepting a null would let
 * an in-flight trip become claimable.
 */

import { parseVerifiedAmountKopecksV1 } from './compensation-money'

export const CASH_ORDER_REJECTIONS_V1 = [
    'order_id_missing',
    'not_completed',
    'payment_method_missing',
    'not_cash',
    'ended_at_missing',
    'ended_at_invalid',
    'price_missing',
    'price_unparseable',
    'driver_profile_missing',
] as const

export type CashOrderRejectionV1 = typeof CASH_ORDER_REJECTIONS_V1[number]

/** Provider status meaning the trip finished. Everything else is not claimable. */
export const COMPLETED_ORDER_STATUS_V1 = 'complete' as const
export const CASH_PAYMENT_METHOD_V1 = 'cash' as const

/** The connection the order was fetched through. Never taken from the payload. */
export interface CashOrderRequestContextV1 {
    provider: string
    externalParkId: string
    /** Which stored connection produced this page, kept for provenance. */
    apiConnectionId: string
    observedAt: Date
}

export interface VerifiedCashOrderProjectionV1 {
    provider: string
    externalParkId: string
    apiConnectionId: string
    externalOrderId: string
    shortOrderIdDisplay: string | null
    externalDriverProfileId: string
    rawPrice: string
    amountKopecks: number
    endedAt: Date
    observedAt: Date
    /** Lookup locator only. Never identity, eligibility or money. */
    providerBookedAt: Date | null
}

export type CashOrderProjectionResultV1 =
    | { accepted: true; order: VerifiedCashOrderProjectionV1 }
    | { accepted: false; reason: CashOrderRejectionV1; externalOrderId: string | null }

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() !== '' ? value : null
}

function optionalInstant(value: unknown): Date | null {
    const raw = nonEmptyString(value)
    if (!raw) return null
    const instant = new Date(raw)
    return Number.isNaN(instant.getTime()) ? null : instant
}

/**
 * Projects one raw order. The raw payload never leaves this function: only the
 * named fields are carried forward, so an upstream error body or anything
 * credential-shaped cannot end up stored alongside the money.
 */
export function projectCashOrderV1(
    raw: unknown,
    context: CashOrderRequestContextV1,
): CashOrderProjectionResultV1 {
    const order = (raw ?? {}) as Record<string, unknown>

    const externalOrderId = nonEmptyString(order.id)
    if (!externalOrderId) return { accepted: false, reason: 'order_id_missing', externalOrderId: null }

    const reject = (reason: CashOrderRejectionV1): CashOrderProjectionResultV1 =>
        ({ accepted: false, reason, externalOrderId })

    if (order.status !== COMPLETED_ORDER_STATUS_V1) return reject('not_completed')

    // Null is how a running order reads. Treating it as "not cash" would be
    // right by accident; treating it as cash would make a live trip claimable.
    const paymentMethod = nonEmptyString(order.payment_method)
    if (!paymentMethod) return reject('payment_method_missing')
    if (paymentMethod !== CASH_PAYMENT_METHOD_V1) return reject('not_cash')

    const endedAtRaw = nonEmptyString(order.ended_at)
    if (!endedAtRaw) return reject('ended_at_missing')
    const endedAt = new Date(endedAtRaw)
    if (Number.isNaN(endedAt.getTime())) return reject('ended_at_invalid')

    const rawPrice = nonEmptyString(order.price)
    if (!rawPrice) return reject('price_missing')

    // The monetary core's own parser, unchanged: four decimals, truncating
    // toward zero, bounded so the value still fits a kopeck column.
    let amountKopecks: number
    try {
        amountKopecks = parseVerifiedAmountKopecksV1(rawPrice)
    } catch {
        return reject('price_unparseable')
    }

    const profile = (order.driver_profile ?? {}) as Record<string, unknown>
    const externalDriverProfileId = nonEmptyString(profile.id)
    if (!externalDriverProfileId) return reject('driver_profile_missing')

    const shortId = order.short_id
    const shortOrderIdDisplay = typeof shortId === 'number' && Number.isFinite(shortId)
        ? String(shortId)
        : nonEmptyString(shortId)

    return {
        accepted: true,
        order: {
            provider: context.provider,
            externalParkId: context.externalParkId,
            apiConnectionId: context.apiConnectionId,
            externalOrderId,
            shortOrderIdDisplay,
            externalDriverProfileId,
            rawPrice,
            amountKopecks,
            endedAt,
            observedAt: context.observedAt,
            providerBookedAt: optionalInstant(order.booked_at),
        },
    }
}

export interface CashOrderPageProjectionV1 {
    accepted: VerifiedCashOrderProjectionV1[]
    rejected: Array<{ externalOrderId: string | null; reason: CashOrderRejectionV1 }>
}

/** Projects a page, keeping the rejections so ingestion stays explainable. */
export function projectCashOrderPageV1(
    rawOrders: readonly unknown[],
    context: CashOrderRequestContextV1,
): CashOrderPageProjectionV1 {
    const accepted: VerifiedCashOrderProjectionV1[] = []
    const rejected: Array<{ externalOrderId: string | null; reason: CashOrderRejectionV1 }> = []
    for (const raw of rawOrders) {
        const result = projectCashOrderV1(raw, context)
        if (result.accepted) accepted.push(result.order)
        else rejected.push({ externalOrderId: result.externalOrderId, reason: result.reason })
    }
    return { accepted, rejected }
}
