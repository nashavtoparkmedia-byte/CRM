/**
 * Selected-park scope and provider freshness for the Telegram pilot.
 *
 * The pilot serves one scope at a time: the park the driver selected in the
 * bot, and the one Driver profile Contacts proved for them. The two must be the
 * same park. Nothing here looks for a profile in another park, and a missing
 * selection is never filled in from the proven profile.
 *
 * Freshness is read from the catalogue row itself. Every accepted provider
 * observation rewrites the row's observedAt in database time, and a decisive
 * removal deletes the row, so the age of observedAt is how long ago Yandex last
 * confirmed this exact order. Two thresholds read it:
 *
 *   order check  45 min  choosing an order within it needs no provider call
 *   submission   60 min  C1 is reached only within it
 *
 * The gap between them is the time a driver has to finish the steps. The
 * whole-park hot age only shapes the catalogue status the driver is shown; it
 * never refuses a claim.
 */

import { createHash } from 'node:crypto'

import { cashOrderDayCoveredV1, hotAgeExceededV1 } from './cash-order-ingestion-windows'
import type { CashOrderIngestionProgressV1 } from './cash-order-ingestion-store'
import {
    COMPENSATION_BUSINESS_TIME_ZONE,
    compensationBusinessDayKeyV1,
    compensationCalendarMonthV1,
    compensationMonthStartInstantV1,
} from './compensation-calendar'
import type { StoredCashOrderV1 } from './compensation-cash-order-ingestion'

const MINUTE = 60_000

export const PILOT_FRESHNESS_V1 = Object.freeze({
    ORDER_CHECK_MAX_AGE_MS: 45 * MINUTE,
    SUBMISSION_MAX_AGE_MS: 60 * MINUTE,
    /** A complete "not returned" verdict older than this is checked again, not repeated. */
    NOT_RETURNED_VALID_MS: 45 * MINUTE,
    /** A failed or incomplete check this recent is reported instead of silently restarted. */
    FAILED_CHECK_REPORT_MS: 10 * MINUTE,
})

/** A catalogue row as the pilot reads it: the stored order plus its provider evidence. */
export interface PilotCatalogueOrderV1 extends StoredCashOrderV1 {
    /** Database time of the latest accepted provider observation of this order. */
    observedAt: Date
    /** Yandex booked_at, a lookup locator for targeted confirmation only. */
    providerBookedAt: Date | null
}

export const PILOT_SCOPE_REFUSALS_V1 = [
    'park_not_selected',
    'driver_not_in_park',
    'selected_park_profile_unproven',
] as const
export type PilotScopeRefusalV1 = typeof PILOT_SCOPE_REFUSALS_V1[number]

export interface PilotScopeV1 {
    externalParkId: string
    externalDriverProfileId: string
    /**
     * Opaque token for this exact scope. The bot echoes it back with every
     * order it offers, so an answer to a list shown for another park or
     * profile is recognised as stale instead of being re-read in a new scope.
     */
    scopeKey: string
}

export type PilotScopeResolutionV1 =
    | { scoped: true; scope: PilotScopeV1 }
    | { scoped: false; refusal: PilotScopeRefusalV1 }

function nonEmpty(value: string | null | undefined): value is string {
    return typeof value === 'string' && value.trim() !== ''
}

export function pilotScopeKeyV1(input: {
    driverId: string
    externalParkId: string
    externalDriverProfileId: string
}): string {
    return createHash('sha256')
        .update(`pilot-scope\0${input.driverId}\0${input.externalParkId}\0${input.externalDriverProfileId}`)
        .digest('hex')
        .slice(0, 12)
}

/**
 * The selected park is the interaction scope, and it must be the proven
 * profile's park. A driver with no selection is asked to make one; a driver who
 * selected another park is refused rather than served from a profile nobody
 * proved belongs to them.
 */
export function resolvePilotScopeV1(input: {
    driverId: string
    selectedExternalParkId: string | null
    externalParkId: string | null
    externalDriverProfileId: string | null
}): PilotScopeResolutionV1 {
    if (!nonEmpty(input.selectedExternalParkId)) return { scoped: false, refusal: 'park_not_selected' }
    if (!nonEmpty(input.externalParkId) || !nonEmpty(input.externalDriverProfileId)) {
        return { scoped: false, refusal: 'driver_not_in_park' }
    }
    if (input.selectedExternalParkId !== input.externalParkId) {
        return { scoped: false, refusal: 'selected_park_profile_unproven' }
    }
    return {
        scoped: true,
        scope: {
            externalParkId: input.externalParkId,
            externalDriverProfileId: input.externalDriverProfileId,
            scopeKey: pilotScopeKeyV1({
                driverId: input.driverId,
                externalParkId: input.externalParkId,
                externalDriverProfileId: input.externalDriverProfileId,
            }),
        },
    }
}

/** How long ago Yandex last confirmed the order, never negative. */
export function providerConfirmationAgeMsV1(order: { observedAt: Date }, dbNow: Date): number {
    return Math.max(0, dbNow.getTime() - order.observedAt.getTime())
}

export function freshForOrderCheckV1(order: { observedAt: Date }, dbNow: Date): boolean {
    return providerConfirmationAgeMsV1(order, dbNow) <= PILOT_FRESHNESS_V1.ORDER_CHECK_MAX_AGE_MS
}

export function freshForSubmissionV1(order: { observedAt: Date }, dbNow: Date): boolean {
    return providerConfirmationAgeMsV1(order, dbNow) <= PILOT_FRESHNESS_V1.SUBMISSION_MAX_AGE_MS
}

/** What the ingestion runtime says about one order's targeted confirmation. */
export interface PilotOrderConfirmationReadV1 {
    state: 'running' | 'confirmed' | 'removed' | 'not_returned' | 'incomplete' | 'failed' | 'undetermined'
    startedAt: Date | null
    endedAt: Date | null
    code: string | null
}

export type PilotConfirmationFollowUpV1 = 'checking' | 'not_confirmed' | 'check_failed' | 'request'

/**
 * What to do about an order whose own observation is too old.
 *
 * Only a complete fallback that did not return the order is a verdict, and only
 * while it is recent and no later observation accepted the order. A failed or
 * incomplete check is never read as "not confirmed": it is reported while
 * recent, so the driver can ask again, and restarted after that.
 */
export function pilotConfirmationFollowUpV1(
    read: PilotOrderConfirmationReadV1,
    order: { observedAt: Date },
    dbNow: Date,
    options: { retry: boolean },
): PilotConfirmationFollowUpV1 {
    switch (read.state) {
        case 'running':
            return 'checking'
        case 'not_returned': {
            const decisive = read.startedAt !== null
                && read.endedAt !== null
                && read.startedAt.getTime() >= order.observedAt.getTime()
                && dbNow.getTime() - read.endedAt.getTime() <= PILOT_FRESHNESS_V1.NOT_RETURNED_VALID_MS
            return decisive ? 'not_confirmed' : 'request'
        }
        case 'incomplete':
        case 'failed': {
            const recent = read.endedAt === null
                || dbNow.getTime() - read.endedAt.getTime() <= PILOT_FRESHNESS_V1.FAILED_CHECK_REPORT_MS
            return recent && !options.retry ? 'check_failed' : 'request'
        }
        default:
            // confirmed, removed or undetermined: the catalogue row is the
            // truth, and it is stale, so it is asked about again.
            return 'request'
    }
}

/** Where a request for targeted confirmation leaves the driver. */
export function pilotScheduleFollowUpV1(outcome: {
    status: 'scheduled' | 'joined' | 'not_scheduled'
    reason: string | null
}): 'checking' | 'check_failed' | 'unavailable' {
    if (outcome.status !== 'not_scheduled') return 'checking'
    switch (outcome.reason) {
        case 'mode_not_write':
        case 'park_not_enabled':
        case 'invalid_day':
            return 'unavailable'
        default:
            return 'check_failed'
    }
}

/** Facts about a park's catalogue, read without any provider call. */
export interface PilotCatalogueFactsV1 extends CashOrderIngestionProgressV1 {
    mode: string
    parkEnabled: boolean
    dbNow: Date
}

export type PilotCatalogueStatusV1 = 'ready' | 'partial' | 'stale' | 'disabled'

/**
 * Whether the local catalogue can be shown, and how much to trust its
 * completeness. An empty catalogue with status ready means there are no
 * orders; disabled means there is no catalogue for this park at all.
 *
 *   disabled  ingestion does not write this park
 *   stale     no successful hot pass for over 10 minutes
 *   partial   reconciliation has not yet covered the current month
 *   ready     otherwise
 */
export function pilotCatalogueStatusV1(facts: PilotCatalogueFactsV1): PilotCatalogueStatusV1 {
    if (facts.mode !== 'write' || !facts.parkEnabled) return 'disabled'
    if (hotAgeExceededV1(facts.lastHotSuccessAt, facts.dbNow)) return 'stale'
    const monthStart = compensationMonthStartInstantV1(compensationCalendarMonthV1(facts.dbNow))
    if (!cashOrderDayCoveredV1(facts, monthStart)) return 'partial'
    return 'ready'
}

const displayFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: COMPENSATION_BUSINESS_TIME_ZONE,
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
})

/** An order as the bot lists it. The bot renders these fields and decides nothing. */
export interface PilotListedOrderV1 {
    externalOrderId: string
    shortOrderIdDisplay: string | null
    amountKopecks: number
    endedAt: Date
    /** Business day the order completed on, `YYYY-MM-DD` Asia/Yekaterinburg. */
    dayKey: string
    /** `HH:MM` on the business clock. */
    localTime: string
    /** `DD.MM` on the business clock. */
    localDate: string
    /** A live or paid claim already holds this order. */
    claimed: boolean
}

export function pilotListedOrderV1(
    order: StoredCashOrderV1,
    claimedOrderIds: readonly string[],
): PilotListedOrderV1 {
    const parts = displayFormatter.formatToParts(order.endedAt)
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '00'
    return {
        externalOrderId: order.externalOrderId,
        shortOrderIdDisplay: order.shortOrderIdDisplay,
        amountKopecks: order.amountKopecks,
        endedAt: order.endedAt,
        dayKey: compensationBusinessDayKeyV1(order.endedAt),
        localTime: `${part('hour')}:${part('minute')}`,
        localDate: `${part('day')}.${part('month')}`,
        claimed: claimedOrderIds.includes(order.externalOrderId),
    }
}

export const PILOT_SEARCH_LIMIT_V1 = 20

export interface PilotOrderSearchV1 {
    query: string
    kind: 'time' | 'number' | 'unsupported'
    /** Every match, newest first. Never narrowed to one on the driver's behalf. */
    matches: PilotListedOrderV1[]
    truncated: boolean
}

/**
 * Finds orders by what a driver can read off their own trip: Yandex's short
 * order number, the whole-rouble price, or the completion time. None of these
 * is proven unique, so every match is returned for the driver to choose from,
 * a single match included.
 */
export function pilotOrderSearchV1(orders: readonly PilotListedOrderV1[], rawQuery: string): PilotOrderSearchV1 {
    const query = rawQuery.trim().replace(/^№\s*/u, '').replace(/\s+/gu, '')
    const time = /^(\d{1,2})[:.](\d{2})$/u.exec(query)
    let kind: PilotOrderSearchV1['kind'] = 'unsupported'
    let matches: PilotListedOrderV1[] = []
    if (time) {
        kind = 'time'
        const wanted = `${time[1].padStart(2, '0')}:${time[2]}`
        matches = orders.filter((order) => order.localTime === wanted)
    } else if (/^\d{1,12}$/u.test(query)) {
        kind = 'number'
        const rubles = Number(query)
        matches = orders.filter((order) => (
            order.shortOrderIdDisplay === query || Math.floor(order.amountKopecks / 100) === rubles
        ))
    }
    return {
        query,
        kind,
        matches: matches.slice(0, PILOT_SEARCH_LIMIT_V1),
        truncated: matches.length > PILOT_SEARCH_LIMIT_V1,
    }
}
