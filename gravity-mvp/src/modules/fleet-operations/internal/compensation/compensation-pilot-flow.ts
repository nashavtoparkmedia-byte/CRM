/**
 * The Telegram pilot flow and the manager flow, as decisions.
 *
 * Everything monetary still belongs to C1: amounts, idempotency, payout
 * authorization, locking and reconciliation are called, never re-derived. What
 * lives here is the pilot's own product rules — what a driver may claim, what
 * they must supply, and which C1 operation a manager action maps onto.
 *
 * The manager vocabulary is approve, reject and mark paid. C1 has no "approved"
 * state, and inventing one would mean altering a frozen monetary constraint.
 * It does not need one: approving is taking the payout authorization, and
 * marking paid is finalizing it. "Awaiting payment" is simply an application
 * that holds a live authorization.
 */

import {
    MAX_COMPENSATION_KOPECKS,
    KOPECKS_PER_RUBLE,
} from './compensation-money'
import type { StoredCashOrderV1 } from './compensation-cash-order-ingestion'

/** The pilot asks for whole rubles and will not take more than this. */
export const PILOT_MAX_CLAIMED_RUBLES = MAX_COMPENSATION_KOPECKS / KOPECKS_PER_RUBLE

export const PILOT_SUBMISSION_REFUSALS_V1 = [
    'support_not_confirmed',
    'attachment_missing',
    'claim_not_whole_rubles',
    'claim_below_minimum',
    'claim_above_pilot_cap',
    'order_not_in_catalogue',
    'order_already_claimed',
    'budget_exhausted',
] as const

export type PilotSubmissionRefusalV1 = typeof PILOT_SUBMISSION_REFUSALS_V1[number]

export interface PilotSubmissionRequestV1 {
    externalOrderId: string
    claimedRubles: number
    /** The driver ticked the "I contacted Yandex support" step. */
    supportConfirmed: boolean
    /** Telegram file reference for the support response. */
    attachmentFileId: string | null
    attachmentKind: string | null
}

export interface PilotSubmissionContextV1 {
    /** Orders the driver may currently claim against. */
    catalogue: readonly StoredCashOrderV1[]
    /** External order ids this driver already has a live or paid claim on. */
    alreadyClaimedOrderIds: readonly string[]
    /** What the budget period can still reserve, in kopecks. */
    remainingBudgetKopecks: number
}

export type PilotSubmissionDecisionV1 =
    | { accepted: true; order: StoredCashOrderV1; claimedRubles: number; attachmentFileId: string; attachmentKind: string }
    | { accepted: false; refusal: PilotSubmissionRefusalV1 }

/**
 * Everything the pilot must be sure of before it hands a claim to C1.
 *
 * The order is checked against the catalogue the driver was actually shown, so
 * an order id typed or replayed from elsewhere cannot be claimed even if it
 * exists in the database.
 */
export function decidePilotSubmissionV1(
    request: PilotSubmissionRequestV1,
    context: PilotSubmissionContextV1,
): PilotSubmissionDecisionV1 {
    const refuse = (refusal: PilotSubmissionRefusalV1): PilotSubmissionDecisionV1 =>
        ({ accepted: false, refusal })

    if (!request.supportConfirmed) return refuse('support_not_confirmed')

    const attachmentFileId = typeof request.attachmentFileId === 'string' && request.attachmentFileId.trim() !== ''
        ? request.attachmentFileId
        : null
    if (!attachmentFileId) return refuse('attachment_missing')

    if (!Number.isInteger(request.claimedRubles)) return refuse('claim_not_whole_rubles')
    if (request.claimedRubles < 1) return refuse('claim_below_minimum')
    if (request.claimedRubles > PILOT_MAX_CLAIMED_RUBLES) return refuse('claim_above_pilot_cap')

    const order = context.catalogue.find((candidate) => candidate.externalOrderId === request.externalOrderId)
    if (!order) return refuse('order_not_in_catalogue')

    if (context.alreadyClaimedOrderIds.includes(order.externalOrderId)) {
        return refuse('order_already_claimed')
    }

    // The payable amount is the lower of the claim and the order, so that is
    // what the budget must be able to cover. Checking the claim alone would
    // refuse a claim the park could actually afford.
    const payableKopecks = Math.min(
        request.claimedRubles * KOPECKS_PER_RUBLE,
        order.amountKopecks,
        MAX_COMPENSATION_KOPECKS,
    )
    if (payableKopecks > context.remainingBudgetKopecks) return refuse('budget_exhausted')

    return {
        accepted: true,
        order,
        claimedRubles: request.claimedRubles,
        attachmentFileId,
        attachmentKind: request.attachmentKind ?? 'document',
    }
}

/** What the driver sees for one application. */
export const PILOT_DRIVER_STATUSES_V1 = [
    'submitted',
    'awaiting_payment',
    'paid',
    'rejected',
] as const

export type PilotDriverStatusV1 = typeof PILOT_DRIVER_STATUSES_V1[number]

export interface ApplicationStatusFactsV1 {
    /** C1 application status: PENDING, PAID or REJECTED. */
    status: string
    /** True when a payout authorization is live or awaiting an outcome. */
    hasLiveAuthorization: boolean
}

/**
 * Translates the monetary record into words a driver understands, without
 * inventing a state the money model does not have. A pending application that
 * holds a live authorization is one a manager has approved and is paying.
 */
export function pilotDriverStatusV1(facts: ApplicationStatusFactsV1): PilotDriverStatusV1 {
    if (facts.status === 'PAID') return 'paid'
    if (facts.status === 'REJECTED') return 'rejected'
    return facts.hasLiveAuthorization ? 'awaiting_payment' : 'submitted'
}

/** Remaining budget for a period, never negative. */
export function remainingBudgetKopecksV1(period: {
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
}): number {
    return Math.max(0, period.limitKopecks - period.reservedKopecks - period.settledKopecks)
}

export const MANAGER_ACTIONS_V1 = ['approve', 'reject', 'mark_paid'] as const
export type ManagerActionV1 = typeof MANAGER_ACTIONS_V1[number]

export type ManagerRoutingV1 =
    | { operation: 'start_payout' }
    | { operation: 'reject_application' }
    | { operation: 'finalize_payout' }
    | { operation: 'resolve_reconciliation' }
    | { refusal: 'approve_requires_pending'
        | 'reject_requires_no_live_authorization'
        | 'mark_paid_requires_authorization' }

export interface ManagerRoutingFactsV1 {
    status: string
    hasLiveAuthorization: boolean
    /** True when C1 opened a reconciliation task for this application. */
    hasOpenReconciliation: boolean
}

/**
 * Maps a manager action onto the C1 operation that performs it.
 *
 * Reject is refused while an authorization is live, because C1 forbids
 * rejecting an application whose payout outcome is still unknown: the money
 * may already have left. The manager must resolve that first.
 */
export function routeManagerActionV1(
    action: ManagerActionV1,
    facts: ManagerRoutingFactsV1,
): ManagerRoutingV1 {
    if (action === 'approve') {
        if (facts.status !== 'PENDING' || facts.hasLiveAuthorization) {
            return { refusal: 'approve_requires_pending' }
        }
        return { operation: 'start_payout' }
    }

    if (action === 'reject') {
        if (facts.hasLiveAuthorization || facts.hasOpenReconciliation) {
            return { refusal: 'reject_requires_no_live_authorization' }
        }
        return { operation: 'reject_application' }
    }

    // mark_paid. A reconciliation task means C1 already lost sight of the
    // outcome, and it has its own resolution path for exactly that.
    if (facts.hasOpenReconciliation) return { operation: 'resolve_reconciliation' }
    if (!facts.hasLiveAuthorization) return { refusal: 'mark_paid_requires_authorization' }
    return { operation: 'finalize_payout' }
}
