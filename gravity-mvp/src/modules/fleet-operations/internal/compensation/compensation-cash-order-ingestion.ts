/**
 * Ingestion of projected cash orders, and the eligible-order catalogue the
 * pilot reads back.
 *
 * Ingestion is idempotent by construction rather than by checking first: the
 * row id is derived from the provider identity, and the database carries a
 * unique index on the same triple. Replaying a page therefore writes the same
 * rows again instead of duplicating a trip, and two concurrent pages cannot
 * race a check-then-insert.
 *
 * Nothing here decides money. It decides which orders exist and which are
 * claimable; the monetary core still owns amounts, deadlines and payouts.
 */

import {
    compensationCalendarMonthV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
} from './compensation-calendar'
import {
    projectCashOrderPageV1,
    type CashOrderRejectionV1,
    type CashOrderRequestContextV1,
    type VerifiedCashOrderProjectionV1,
} from './compensation-cash-order-projection'
import { compensationDerivedIdV1 } from './compensation-identity'
import { compensationPilotEligibilityV1, type CompensationEligibilityFactsV1 } from './compensation-eligibility'

/**
 * Stable row identity. Derived from the provider triple only, so the same trip
 * always lands on the same row no matter when it is seen.
 */
export function cashOrderRowIdV1(order: {
    provider: string
    externalParkId: string
    externalOrderId: string
}): string {
    return compensationDerivedIdV1(
        'comp_cash_order',
        order.provider,
        order.externalParkId,
        order.externalOrderId,
    )
}

export interface CashOrderIngestionPortV1 {
    /** Must upsert on the provider identity, never blind-insert. */
    upsertCashOrder(row: VerifiedCashOrderProjectionV1 & { id: string }): Promise<void>
}

export interface CashOrderIngestionResultV1 {
    ingested: number
    rejected: Array<{ externalOrderId: string | null; reason: CashOrderRejectionV1 }>
}

export async function ingestCashOrderPageV1(
    rawOrders: readonly unknown[],
    context: CashOrderRequestContextV1,
    port: CashOrderIngestionPortV1,
): Promise<CashOrderIngestionResultV1> {
    const page = projectCashOrderPageV1(rawOrders, context)
    for (const order of page.accepted) {
        await port.upsertCashOrder({ ...order, id: cashOrderRowIdV1(order) })
    }
    return { ingested: page.accepted.length, rejected: page.rejected }
}

/** A stored cash order, as the catalogue reads it back. */
export interface StoredCashOrderV1 {
    id: string
    provider: string
    externalParkId: string
    externalOrderId: string
    shortOrderIdDisplay: string | null
    externalDriverProfileId: string
    rawPrice: string
    amountKopecks: number
    endedAt: Date
}

export type CashOrderCatalogueV1 =
    | {
        eligible: true
        firstMonthKey: string
        orders: readonly StoredCashOrderV1[]
    }
    | {
        eligible: false
        reason: string
        orders: readonly []
    }

/**
 * The orders a driver may claim against right now.
 *
 * Eligibility is evaluated first and the catalogue is empty unless it passes,
 * so an ineligible driver is never shown a list they cannot act on. Orders are
 * then confined to the driver's first calendar month in the park, measured on
 * the same Yekaterinburg calendar the budget period uses, so the two can never
 * disagree about which month an order belongs to.
 */
export function cashOrderCatalogueV1(
    facts: CompensationEligibilityFactsV1,
    storedOrders: readonly StoredCashOrderV1[],
    now: Date,
): CashOrderCatalogueV1 {
    const eligibility = compensationPilotEligibilityV1(facts, now)
    if (!eligibility.eligible) {
        return { eligible: false, reason: eligibility.reason, orders: [] }
    }

    const monthStart = compensationMonthStartInstantV1(eligibility.firstMonth).getTime()
    const monthEnd = compensationMonthEndInstantV1(eligibility.firstMonth).getTime()

    const orders = storedOrders
        .filter((order) => {
            const ended = order.endedAt.getTime()
            return ended >= monthStart && ended < monthEnd
        })
        .slice()
        .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime())

    return { eligible: true, firstMonthKey: eligibility.firstMonthKey, orders }
}

/** The budget period an order belongs to: its own month, not the submission month. */
export function cashOrderBudgetPeriodKeyV1(order: { endedAt: Date }): string {
    return compensationPeriodKeyV1(compensationCalendarMonthV1(order.endedAt))
}
