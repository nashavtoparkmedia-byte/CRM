/**
 * One slice of cash-order ingestion: every page of one booked_at window,
 * fetched through one connection and written through the canonical page
 * writer under the lease the caller holds.
 *
 * The slice is the unit of progress. Pages that committed stay committed, but
 * freshness or reconciliation progress moves only with the final page (a
 * response with no cursor), in the same transaction. A slice that fails or
 * runs out of budget part-way leaves progress where it was, and the next run
 * replays it from its upper edge.
 */

import { CASH_ORDER_INGESTION_TIMING_V1 as T, type CashOrderBudgetV1 } from './cash-order-ingestion-budget'
import {
    CashOrderLeaseLostError,
    type CashOrderIngestionProgressV1,
    type CashOrderIngestionStoreV1,
} from './cash-order-ingestion-store'
import type { BookingWindowV1 } from './cash-order-ingestion-windows'
import { classifyCashOrderPageV1, type CashOrderRemovalReasonV1 } from './cash-order-page-classifier'
import { cashOrderRowIdV1 } from './compensation-cash-order-ingestion'
import {
    requestCashOrderPageV1,
    type CashOrderPageFetcherV1,
    type CashOrderProviderCredentialV1,
    type CashOrderProviderFailureV1,
    type CashOrderRequestProfileV1,
    type CashOrderRequestStatsV1,
} from './yandex-cash-order-source'

export type CashOrderSliceFailureV1 =
    | 'lease_lost'
    | 'canonical_write_failed'
    | 'provider_page_inconsistent'
    | 'provider_pagination_invalid'
    | 'slice_truncated'
    | 'targeted_budget_exhausted'
    | CashOrderProviderFailureV1
    | 'park_time_budget_exhausted'

export interface CashOrderSliceCountersV1 {
    pages: number
    accepted: number
    inserted: number
    updated: number
    guardedNoops: number
    driverReassigned: number
    amountChanged: number
    endedAtChanged: number
    removed: Record<CashOrderRemovalReasonV1, number>
    ignored: number
    collapsedDuplicates: number
}

export function emptyCashOrderSliceCountersV1(): CashOrderSliceCountersV1 {
    return {
        pages: 0,
        accepted: 0,
        inserted: 0,
        updated: 0,
        guardedNoops: 0,
        driverReassigned: 0,
        amountChanged: 0,
        endedAtChanged: 0,
        removed: { not_completed: 0, not_cash: 0, not_payable: 0 },
        ignored: 0,
        collapsedDuplicates: 0,
    }
}

export function addCashOrderSliceCountersV1(total: CashOrderSliceCountersV1, part: CashOrderSliceCountersV1): void {
    total.pages += part.pages
    total.accepted += part.accepted
    total.inserted += part.inserted
    total.updated += part.updated
    total.guardedNoops += part.guardedNoops
    total.driverReassigned += part.driverReassigned
    total.amountChanged += part.amountChanged
    total.endedAtChanged += part.endedAtChanged
    total.removed.not_completed += part.removed.not_completed
    total.removed.not_cash += part.removed.not_cash
    total.removed.not_payable += part.removed.not_payable
    total.ignored += part.ignored
    total.collapsedDuplicates += part.collapsedDuplicates
}

export interface CashOrderSliceInputV1 {
    store: CashOrderIngestionStoreV1
    fetchPage: CashOrderPageFetcherV1
    provider: string
    externalParkId: string
    connectionId: string
    credential: CashOrderProviderCredentialV1
    checkpointId: string
    leaseToken: string
    window: BookingWindowV1
    budget: CashOrderBudgetV1
    profile: CashOrderRequestProfileV1
    /** dry_run fetches and classifies but never writes. */
    mode: 'dry_run' | 'write'
    /** Committed with the final page only. Null for slices that move no progress. */
    finalProgress: { expected: CashOrderIngestionProgressV1; next: CashOrderIngestionProgressV1 } | null
    /** Asked before every request; false ends the slice without fetching. */
    admitPage?: () => boolean
    stats: CashOrderRequestStatsV1
    sleep: (durationMs: number) => Promise<void>
    random: () => number
    wallNowMs: () => number
}

export type CashOrderSliceResultV1 =
    | {
        status: 'complete'
        counters: CashOrderSliceCountersV1
        acceptedOrderIds: Set<string>
        removedOrderIds: Set<string>
    }
    | {
        status: 'failed'
        code: CashOrderSliceFailureV1
        httpStatus: number | null
        deferSeconds: number | null
        counters: CashOrderSliceCountersV1
        acceptedOrderIds: Set<string>
        removedOrderIds: Set<string>
    }

export async function runCashOrderSliceV1(input: CashOrderSliceInputV1): Promise<CashOrderSliceResultV1> {
    const counters = emptyCashOrderSliceCountersV1()
    const acceptedOrderIds = new Set<string>()
    const removedOrderIds = new Set<string>()
    const fail = (code: CashOrderSliceFailureV1, httpStatus: number | null = null, deferSeconds: number | null = null): CashOrderSliceResultV1 =>
        ({ status: 'failed', code, httpStatus, deferSeconds, counters, acceptedOrderIds, removedOrderIds })

    const seenCursors = new Set<string>()
    let cursor: string | null = null
    for (;;) {
        if (counters.pages >= T.SLICE_PAGE_CAP) return fail('slice_truncated')
        if (input.admitPage && !input.admitPage()) return fail('targeted_budget_exhausted')

        const outcome = await requestCashOrderPageV1({
            credentials: input.credential,
            bookedFrom: input.window.from,
            bookedTo: input.window.to,
            cursor,
        }, {
            fetchPage: input.fetchPage,
            budget: input.budget,
            profile: input.profile,
            sleep: input.sleep,
            random: input.random,
            wallNowMs: input.wallNowMs,
            stats: input.stats,
        })
        if (!outcome.ok) return fail(outcome.code, outcome.httpStatus, outcome.deferSeconds)
        counters.pages += 1

        // An empty page ends the stream the same way a missing cursor does.
        const final = outcome.cursor === null || outcome.orders.length === 0
        if (!final) {
            if (outcome.cursor === cursor || seenCursors.has(outcome.cursor as string)) return fail('provider_pagination_invalid')
            seenCursors.add(outcome.cursor as string)
        }

        const classification = classifyCashOrderPageV1(outcome.orders, {
            provider: input.provider,
            externalParkId: input.externalParkId,
            apiConnectionId: input.connectionId,
            observedAt: new Date(input.wallNowMs()),
        })
        if (!classification.consistent) return fail('provider_page_inconsistent')
        const decisions = classification.decisions

        if (input.mode === 'write') {
            try {
                const written = await input.store.writePage({
                    checkpointId: input.checkpointId,
                    leaseToken: input.leaseToken,
                    provider: input.provider,
                    externalParkId: input.externalParkId,
                    sourceConnectionId: input.connectionId,
                    accepted: decisions.accepted.map((order) => ({
                        id: cashOrderRowIdV1(order),
                        externalOrderId: order.externalOrderId,
                        shortOrderIdDisplay: order.shortOrderIdDisplay,
                        externalDriverProfileId: order.externalDriverProfileId,
                        rawPrice: order.rawPrice,
                        amountKopecks: order.amountKopecks,
                        endedAt: order.endedAt,
                        providerBookedAt: order.providerBookedAt,
                    })),
                    removedOrderIds: decisions.removals.map((removal) => removal.externalOrderId),
                    progress: final ? input.finalProgress : null,
                })
                counters.inserted += written.inserted
                counters.updated += written.updated
                counters.guardedNoops += written.guardedNoops
                counters.driverReassigned += written.driverReassigned
                counters.amountChanged += written.amountChanged
                counters.endedAtChanged += written.endedAtChanged
            } catch (error) {
                // Any other failure, a progress conflict included, rolled the
                // page back whole; the slice fails and replays next time.
                return fail(error instanceof CashOrderLeaseLostError ? 'lease_lost' : 'canonical_write_failed')
            }
        }

        counters.accepted += decisions.accepted.length
        counters.ignored += Object.values(decisions.ignoredByReason).reduce((sum, count) => sum + (count ?? 0), 0)
        counters.collapsedDuplicates += decisions.collapsedDuplicates
        for (const order of decisions.accepted) {
            acceptedOrderIds.add(order.externalOrderId)
            removedOrderIds.delete(order.externalOrderId)
        }
        for (const removal of decisions.removals) {
            counters.removed[removal.reason] += 1
            removedOrderIds.add(removal.externalOrderId)
            acceptedOrderIds.delete(removal.externalOrderId)
        }

        if (final) return { status: 'complete', counters, acceptedOrderIds, removedOrderIds }

        if (!input.budget.admitsSleep(T.POLITE_PAGE_DELAY_MS)) return fail('park_time_budget_exhausted')
        await input.sleep(T.POLITE_PAGE_DELAY_MS)
        cursor = outcome.cursor
    }
}
