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
    compensationPeriodKeyV1,
} from './compensation-calendar'
import {
    projectCashOrderPageV1,
    type CashOrderRejectionV1,
    type CashOrderRequestContextV1,
    type VerifiedCashOrderProjectionV1,
} from './compensation-cash-order-projection'
import { compensationDerivedIdV1 } from './compensation-identity'
import { compensationPilotFirstMonthV1, type CompensationEligibilityFactsV1 } from './compensation-eligibility'
import { compensationSubmissionDeadlineV1, isSubmissionWindowOpenV1 } from './compensation-submission-window'

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

export type CashOrderCatalogueV1<T extends StoredCashOrderV1 = StoredCashOrderV1> =
    | {
        eligible: true
        firstMonthKey: string
        orders: readonly T[]
    }
    | {
        eligible: false
        reason: string
        orders: readonly []
    }

/**
 * Whether one order can still be submitted at `now`, by the monetary core's
 * own rule: until the end of the order's business month, or for 72 hours from
 * completion when the order completed on that month's last calendar day. This
 * is the same deadline C1 stores on the claim and refuses against, read here
 * so the list never offers what the submit would refuse.
 */
export function cashOrderSubmissionOpenV1(order: { endedAt: Date }, now: Date): boolean {
    return isSubmissionWindowOpenV1(now, compensationSubmissionDeadlineV1(order.endedAt))
}

/**
 * The orders a driver may claim against right now.
 *
 * The facts gate is evaluated first and the catalogue is empty unless it
 * passes, so an ineligible driver is never shown a list they cannot act on.
 * Orders are then confined to the driver's first calendar month in the park,
 * measured on the same Yekaterinburg calendar the budget period uses, so the
 * two can never disagree about which month an order belongs to, and each is
 * kept only while its own submission window is open.
 *
 * Inside the first month that last test changes nothing: every first-month
 * order's deadline is the month's end or later. Once the month has ended it is
 * what keeps a last-day order claimable through its 72-hour grace, and nothing
 * else: an ordinary order of the month closed with the month, and the month
 * itself is reported as over once no order is left in its grace. The driver's
 * window is never widened; the order's earned window is simply not thrown away
 * at the calendar rollover.
 */
export function cashOrderCatalogueV1<T extends StoredCashOrderV1>(
    facts: CompensationEligibilityFactsV1,
    storedOrders: readonly T[],
    now: Date,
): CashOrderCatalogueV1<T> {
    const first = compensationPilotFirstMonthV1(facts)
    if (!first.ok) return { eligible: false, reason: first.reason, orders: [] }

    const monthStart = first.windowStartsAt.getTime()
    const monthEnd = first.windowEndsAt.getTime()
    if (now.getTime() < monthStart) {
        return { eligible: false, reason: 'outside_first_calendar_month', orders: [] }
    }

    const orders = storedOrders
        .filter((order) => {
            const ended = order.endedAt.getTime()
            return ended >= monthStart && ended < monthEnd && cashOrderSubmissionOpenV1(order, now)
        })
        .slice()
        .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime())

    if (now.getTime() >= monthEnd && orders.length === 0) {
        return { eligible: false, reason: 'outside_first_calendar_month', orders: [] }
    }

    return { eligible: true, firstMonthKey: first.firstMonthKey, orders }
}

/** The budget period an order belongs to: its own month, not the submission month. */
export function cashOrderBudgetPeriodKeyV1(order: { endedAt: Date }): string {
    return compensationPeriodKeyV1(compensationCalendarMonthV1(order.endedAt))
}
