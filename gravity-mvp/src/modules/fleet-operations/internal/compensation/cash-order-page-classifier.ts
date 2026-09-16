/**
 * Classification of one provider page for the current claimable catalogue.
 *
 * The landed projection decides what an order is; this decides what the
 * catalogue does about it. Every order is exactly one of:
 *
 *   accept  complete, cash, well-formed and payable (more than 0 kopecks)
 *   remove  a positive disqualification the provider stated explicitly:
 *             not_completed  status is a non-empty value other than complete
 *             not_cash       a complete order whose payment method is a
 *                            non-empty value other than cash
 *             not_payable    accepted by the projection, but 0 kopecks
 *   ignore  anything else: a missing status, a null payment method, a missing
 *           or unreadable price, end time or profile, or no id at all
 *
 * Ignoring is deliberate. A running order has no payment method yet and an
 * incomplete payload proves nothing, so neither may delete a row. Absence from
 * a page is not visible here at all and never removes anything.
 */

import {
    projectCashOrderV1,
    type CashOrderRejectionV1,
    type CashOrderRequestContextV1,
    type VerifiedCashOrderProjectionV1,
} from './compensation-cash-order-projection'

export const CASH_ORDER_REMOVAL_REASONS_V1 = ['not_completed', 'not_cash', 'not_payable'] as const
export type CashOrderRemovalReasonV1 = typeof CASH_ORDER_REMOVAL_REASONS_V1[number]

export interface CashOrderPageDecisionsV1 {
    /** One entry per order id, amount above zero. */
    accepted: VerifiedCashOrderProjectionV1[]
    removals: Array<{ externalOrderId: string; reason: CashOrderRemovalReasonV1 }>
    ignoredByReason: Partial<Record<CashOrderRejectionV1, number>>
    /** Identical copies of an order folded into one. */
    collapsedDuplicates: number
}

export type CashOrderPageClassificationV1 =
    | { consistent: true; decisions: CashOrderPageDecisionsV1 }
    | { consistent: false; code: 'provider_page_inconsistent'; externalOrderId: string }

type Decision =
    | { kind: 'accept'; order: VerifiedCashOrderProjectionV1 }
    | { kind: 'remove'; externalOrderId: string; reason: CashOrderRemovalReasonV1 }
    | { kind: 'ignore'; externalOrderId: string | null; reason: CashOrderRejectionV1 }

function decide(raw: unknown, context: CashOrderRequestContextV1): Decision {
    const projected = projectCashOrderV1(raw, context)
    if (projected.accepted) {
        return projected.order.amountKopecks > 0
            ? { kind: 'accept', order: projected.order }
            : { kind: 'remove', externalOrderId: projected.order.externalOrderId, reason: 'not_payable' }
    }
    const { reason, externalOrderId } = projected
    if (externalOrderId !== null) {
        // The projection also says not_completed when status is missing, so the
        // raw value is re-read: only an explicit other status is decisive.
        const status = (raw as Record<string, unknown>).status
        if (reason === 'not_completed' && typeof status === 'string' && status.trim() !== '') {
            return { kind: 'remove', externalOrderId, reason: 'not_completed' }
        }
        if (reason === 'not_cash') return { kind: 'remove', externalOrderId, reason: 'not_cash' }
    }
    return { kind: 'ignore', externalOrderId, reason }
}

/** Everything that identifies one decision, so two copies can be compared. */
function signature(decision: Decision): string {
    if (decision.kind !== 'accept') return `${decision.kind}:${decision.reason}`
    const order = decision.order
    return JSON.stringify([
        'accept',
        order.shortOrderIdDisplay,
        order.externalDriverProfileId,
        order.rawPrice,
        order.amountKopecks,
        order.endedAt.toISOString(),
        order.providerBookedAt?.toISOString() ?? null,
    ])
}

/**
 * Classifies a page. Copies of one order that agree in every decided value
 * fold into one; copies that disagree make the whole page untrustworthy, and
 * nothing from it may be written.
 */
export function classifyCashOrderPageV1(
    rawOrders: readonly unknown[],
    context: CashOrderRequestContextV1,
): CashOrderPageClassificationV1 {
    const byId = new Map<string, { decision: Decision; signature: string }>()
    const ignoredByReason: Partial<Record<CashOrderRejectionV1, number>> = {}
    let collapsedDuplicates = 0

    for (const raw of rawOrders) {
        const decision = decide(raw, context)
        if (decision.kind === 'ignore') {
            ignoredByReason[decision.reason] = (ignoredByReason[decision.reason] ?? 0) + 1
        }
        const id = decision.kind === 'accept' ? decision.order.externalOrderId : decision.externalOrderId
        if (id === null) continue
        const current = { decision, signature: signature(decision) }
        const previous = byId.get(id)
        if (previous === undefined) {
            byId.set(id, current)
        } else if (previous.signature === current.signature) {
            collapsedDuplicates += 1
        } else {
            return { consistent: false, code: 'provider_page_inconsistent', externalOrderId: id }
        }
    }

    const accepted: VerifiedCashOrderProjectionV1[] = []
    const removals: CashOrderPageDecisionsV1['removals'] = []
    for (const { decision } of byId.values()) {
        if (decision.kind === 'accept') accepted.push(decision.order)
        else if (decision.kind === 'remove') removals.push({ externalOrderId: decision.externalOrderId, reason: decision.reason })
    }
    return { consistent: true, decisions: { accepted, removals, ignoredByReason, collapsedDuplicates } }
}
