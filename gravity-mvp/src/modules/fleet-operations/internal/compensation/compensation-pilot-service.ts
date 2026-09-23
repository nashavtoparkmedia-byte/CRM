/**
 * The seam both pilot surfaces call: the Telegram bot and the manager screen.
 *
 * Neither surface is allowed its own copy of a rule. Everything decided here
 * comes from the already-proven decision functions, and everything monetary is
 * delegated to C1 unchanged. A screen renders what this returns; it does not
 * work anything out for itself.
 *
 * The port keeps the reads and writes replaceable so the service can be proven
 * without a database, and driven against a real one in acceptance.
 *
 * The Telegram surface works in one scope: the park the driver selected, which
 * must be the park of the one Driver profile Contacts proved. Every request
 * rebuilds that scope from what the webhook read for it, never from the
 * conversation. The list is read from the local catalogue only; Yandex is asked
 * about one order, asynchronously, when that order's own observation is too old
 * (see compensation-pilot-selection), and C1 is reached only with an order
 * Yandex confirmed within the submission threshold.
 */

import { cashOrderCatalogueV1 } from './compensation-cash-order-ingestion'
import { compensationBusinessDayKeyV1 } from './compensation-calendar'
import type { CompensationEligibilityFactsV1 } from './compensation-eligibility'
import {
    freshForOrderCheckV1,
    freshForSubmissionV1,
    pilotCatalogueStatusV1,
    pilotConfirmationFollowUpV1,
    pilotListedOrderV1,
    pilotOrderSearchV1,
    pilotScheduleFollowUpV1,
    resolvePilotScopeV1,
    type PilotCatalogueFactsV1,
    type PilotCatalogueOrderV1,
    type PilotListedOrderV1,
    type PilotOrderConfirmationReadV1,
    type PilotOrderSearchV1,
    type PilotScopeRefusalV1,
    type PilotScopeV1,
} from './compensation-pilot-selection'
import {
    decidePilotSubmissionV1,
    pilotDriverStatusV1,
    remainingBudgetKopecksV1,
    type PilotDriverStatusV1,
    type PilotSubmissionRefusalV1,
} from './compensation-pilot-flow'

/**
 * What the Telegram webhook proved before it called the pilot.
 *
 * Telegram channel authority established that the exact private chat belongs
 * to a Contact confirmed as this Driver's person. fleet_operations may not read
 * Telegram channel state, so the service re-checks the Contact-to-Driver
 * confirmation and resolves the person through Contacts' public reads. The
 * Telegram user id is carried as submission evidence; the webhook is the only
 * caller that can prove it.
 *
 * The selected park is read by the webhook from the same Telegram link, in the
 * same request. The bot never supplies it.
 */
export interface PilotTelegramPersonProofV1 {
    telegramUserId: string
    driverId: string
    contactId: string
    selectedExternalParkId: string | null
}

export type PilotMainDriverConfirmationV1 = 'confirmed' | 'not_confirmed' | 'busy'

export type PilotContactLineageReadV1 =
    | { status: 'resolved'; canonicalContactId: string; contactIds: readonly string[] }
    | { status: 'missing' }
    /** Contacts could not walk the merge redirects to one canonical contact. */
    | { status: 'unresolvable' }

export interface PilotDriverFactsV1 {
    externalParkId: string | null
    externalDriverProfileId: string | null
    facts: CompensationEligibilityFactsV1
}

export interface PilotDriverIdentityV1 extends PilotDriverFactsV1 {
    telegramUserId: string
    /** Canonical contact proven for this Telegram account. */
    canonicalContactId: string
    /** The contacts C1 binds to the monetary person; the pilot admits one. */
    lineage: readonly string[]
}

export interface PilotApplicationSummaryV1 {
    applicationId: string
    status: PilotDriverStatusV1
    externalOrderId: string
    shortOrderIdDisplay: string | null
    claimedKopecks: number
    amountKopecks: number
    verifiedKopecks: number
    submittedAt: Date
    rejectionReason: string | null
}

export interface CompensationPilotPortV1 {
    /** Contacts' confirmation that the Contact's person is this Driver. */
    confirmMainDriver(contactId: string, driverId: string): Promise<PilotMainDriverConfirmationV1>
    resolveContactLineage(contactId: string): Promise<PilotContactLineageReadV1>
    /** The facts eligibility needs, read from the proven Driver row only. */
    findDriverFacts(driverId: string): Promise<PilotDriverFactsV1 | null>
    findCashOrders(input: { externalParkId: string; externalDriverProfileId: string }): Promise<PilotCatalogueOrderV1[]>
    findBudgetPeriod(periodKey: string): Promise<{
        limitKopecks: number; reservedKopecks: number; settledKopecks: number
    } | null>
    findClaimedOrderIds(lineage: readonly string[]): Promise<string[]>
    findDriverApplications(lineage: readonly string[]): Promise<PilotApplicationSummaryV1[]>
    /**
     * C1 submit, plus the pilot evidence, as one unit. The order carries the
     * observation time C1 records as its verification time.
     */
    submitApplication(input: {
        canonicalContactId: string
        lineage: readonly string[]
        order: PilotCatalogueOrderV1
        claimedRubles: number
        telegramUserId: string
        attachmentFileId: string
        attachmentKind: string
        idempotencyKey: string
        submittedAt: Date
    }): Promise<
        | { applicationId: string; amountKopecks: number; status: 'created' | 'replayed' }
        /** C1 refused the claim; its code is passed on to the driver. */
        | { refusal: string }
    >
}

/**
 * What the pilot may ask of cash-order ingestion. Every call is local or only
 * schedules work: none of them waits for Yandex.
 */
export interface CompensationPilotIngestionPortV1 {
    /** Mode, park enablement and catalogue progress, in database time. */
    readCatalogueFacts(externalParkId: string): Promise<PilotCatalogueFactsV1>
    requestHotRefresh(externalParkId: string): Promise<PilotScheduleOutcomeV1>
    requestOrderConfirmation(input: {
        externalParkId: string
        dayKey: string
        externalOrderId: string
        providerBookedAt: Date | null
    }): Promise<PilotScheduleOutcomeV1>
    readOrderConfirmation(input: {
        externalParkId: string
        dayKey: string
        externalOrderId: string
    }): Promise<PilotOrderConfirmationReadV1>
}

export interface PilotScheduleOutcomeV1 {
    status: 'scheduled' | 'joined' | 'not_scheduled'
    reason: string | null
}

export const PILOT_VIEW_REFUSALS_V1 = [
    'identity_not_proven',
    'identity_needs_review',
    'identity_busy',
    'park_not_selected',
    'driver_not_in_park',
    'selected_park_profile_unproven',
    'catalogue_disabled',
] as const
export type PilotViewRefusalV1 = typeof PILOT_VIEW_REFUSALS_V1[number]

/** Refusals of the Telegram submit that come from scope and freshness, not from the claim. */
export const PILOT_FRESHNESS_REFUSALS_V1 = [
    'stale_context',
    'order_confirmation_pending',
    'order_not_confirmed',
    'order_check_failed',
    'order_check_unavailable',
] as const
export type PilotFreshnessRefusalV1 = typeof PILOT_FRESHNESS_REFUSALS_V1[number]

export type CompensationSectionViewV1 =
    | {
        available: true
        scopeKey: string
        externalParkId: string
        firstMonthKey: string
        remainingBudgetKopecks: number
        catalogueStatus: 'ready' | 'partial' | 'stale'
        /** Business day of the database clock, so "today" is the catalogue's today. */
        todayKey: string
        orders: readonly PilotListedOrderV1[]
        search: PilotOrderSearchV1 | null
        applications: readonly PilotApplicationSummaryV1[]
    }
    | {
        available: false
        reason: PilotViewRefusalV1 | string
        applications: readonly PilotApplicationSummaryV1[]
    }

export type PilotIdentityResolutionV1 =
    | { proven: true; identity: PilotDriverIdentityV1 }
    | { proven: false; refusal: 'identity_not_proven' | 'identity_needs_review' | 'identity_busy' }

function exactText(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value === value.trim()
}

/**
 * Turns the webhook's proof into the canonical person C1 will bind.
 *
 * Fails closed at every step. A lineage of more than one contact is refused
 * rather than bound: C1 never re-points a binding, and Contacts' lineage read
 * does not yet exclude recovered merges or follow a chain transitively, so
 * binding it could attach an unrelated person to this monetary identity.
 */
export async function resolvePilotIdentityV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
): Promise<PilotIdentityResolutionV1> {
    if (!exactText(proof.telegramUserId) || !exactText(proof.driverId) || !exactText(proof.contactId)) {
        return { proven: false, refusal: 'identity_not_proven' }
    }

    const confirmation = await port.confirmMainDriver(proof.contactId, proof.driverId)
    if (confirmation === 'busy') return { proven: false, refusal: 'identity_busy' }
    if (confirmation !== 'confirmed') return { proven: false, refusal: 'identity_not_proven' }

    const lineage = await port.resolveContactLineage(proof.contactId)
    if (lineage.status === 'unresolvable') return { proven: false, refusal: 'identity_needs_review' }
    if (lineage.status !== 'resolved' || lineage.canonicalContactId !== proof.contactId) {
        return { proven: false, refusal: 'identity_not_proven' }
    }
    if (lineage.contactIds.length !== 1 || lineage.contactIds[0] !== proof.contactId) {
        return { proven: false, refusal: 'identity_needs_review' }
    }

    const driver = await port.findDriverFacts(proof.driverId)
    if (!driver) return { proven: false, refusal: 'identity_not_proven' }

    return {
        proven: true,
        identity: {
            telegramUserId: proof.telegramUserId,
            canonicalContactId: proof.contactId,
            lineage: [proof.contactId],
            externalParkId: driver.externalParkId,
            externalDriverProfileId: driver.externalDriverProfileId,
            facts: driver.facts,
        },
    }
}

interface ScopedSectionV1 {
    scope: PilotScopeV1
    firstMonthKey: string
    remainingBudgetKopecks: number
    catalogueStatus: 'ready' | 'partial' | 'stale'
    dbNow: Date
    /** The eligible catalogue of this scope, newest first. */
    orders: readonly PilotCatalogueOrderV1[]
    claimedOrderIds: readonly string[]
}

type ScopedSectionResultV1 =
    | { available: true; applications: readonly PilotApplicationSummaryV1[]; section: ScopedSectionV1 }
    | {
        available: false
        reason: PilotScopeRefusalV1 | 'catalogue_disabled' | string
        applications: readonly PilotApplicationSummaryV1[]
    }

/**
 * Everything the Telegram surface may act on for one proven person, rebuilt
 * from the database on every request. Local reads only.
 */
async function scopedSectionV1(
    identity: PilotDriverIdentityV1,
    selectedExternalParkId: string | null,
    driverId: string,
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
): Promise<ScopedSectionResultV1> {
    const applications = await port.findDriverApplications(identity.lineage)

    const scoped = resolvePilotScopeV1({
        driverId,
        selectedExternalParkId,
        externalParkId: identity.externalParkId,
        externalDriverProfileId: identity.externalDriverProfileId,
    })
    if (!scoped.scoped) return { available: false, reason: scoped.refusal, applications }
    const scope = scoped.scope

    const stored = await port.findCashOrders({
        externalParkId: scope.externalParkId,
        externalDriverProfileId: scope.externalDriverProfileId,
    })
    const catalogue = cashOrderCatalogueV1(identity.facts, stored, now)
    if (!catalogue.eligible) {
        return { available: false, reason: catalogue.reason, applications }
    }

    // No catalogue is not the same as an empty one: a park ingestion does not
    // write has no list to show at all.
    const facts = await ingestion.readCatalogueFacts(scope.externalParkId)
    const catalogueStatus = pilotCatalogueStatusV1(facts)
    if (catalogueStatus === 'disabled') {
        return { available: false, reason: 'catalogue_disabled', applications }
    }

    const period = await port.findBudgetPeriod(catalogue.firstMonthKey)
    return {
        available: true,
        applications,
        section: {
            scope,
            firstMonthKey: catalogue.firstMonthKey,
            remainingBudgetKopecks: period ? remainingBudgetKopecksV1(period) : 0,
            catalogueStatus,
            dbNow: facts.dbNow,
            orders: catalogue.orders,
            claimedOrderIds: await port.findClaimedOrderIds(identity.lineage),
        },
    }
}

/**
 * What the compensation section shows.
 *
 * An unproven identity yields no list at all rather than an empty one: the
 * driver is told their account is not linked, which is a different problem
 * from having no eligible orders. A search, when asked for, is answered from
 * the same rebuilt catalogue.
 */
export async function compensationSectionViewV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
    options: { search?: string | null } = {},
): Promise<CompensationSectionViewV1> {
    const resolved = await resolvePilotIdentityV1(proof, port)
    if (!resolved.proven) return { available: false, reason: resolved.refusal, applications: [] }
    // The public section is a plain view built here, never a value handed back
    // from a helper that holds the port.
    const view = await scopedSectionV1(resolved.identity, proof.selectedExternalParkId, proof.driverId, port, ingestion, now)
    if (!view.available) return { available: false, reason: view.reason, applications: view.applications }

    const section = view.section
    const orders = section.orders.map((order) => pilotListedOrderV1(order, section.claimedOrderIds))
    const search = typeof options.search === 'string' && options.search.trim() !== ''
        ? pilotOrderSearchV1(orders, options.search)
        : null
    return {
        available: true,
        scopeKey: section.scope.scopeKey,
        externalParkId: section.scope.externalParkId,
        firstMonthKey: section.firstMonthKey,
        remainingBudgetKopecks: section.remainingBudgetKopecks,
        catalogueStatus: section.catalogueStatus,
        todayKey: compensationBusinessDayKeyV1(section.dbNow),
        orders,
        search,
        applications: view.applications,
    }
}

async function confirmationFollowUpV1(
    scope: PilotScopeV1,
    order: PilotCatalogueOrderV1,
    dbNow: Date,
    ingestion: CompensationPilotIngestionPortV1,
    retry: boolean,
): Promise<'checking' | 'not_confirmed' | 'check_failed' | 'unavailable'> {
    const dayKey = compensationBusinessDayKeyV1(order.endedAt)
    const read = await ingestion.readOrderConfirmation({
        externalParkId: scope.externalParkId,
        dayKey,
        externalOrderId: order.externalOrderId,
    })
    const next = pilotConfirmationFollowUpV1(read, order, dbNow, { retry })
    if (next !== 'request') return next
    return pilotScheduleFollowUpV1(await ingestion.requestOrderConfirmation({
        externalParkId: scope.externalParkId,
        dayKey,
        externalOrderId: order.externalOrderId,
        providerBookedAt: order.providerBookedAt,
    }))
}

export type PilotOrderCheckStateV1 =
    | 'fresh'
    | 'checking'
    | 'not_confirmed'
    | 'check_failed'
    | 'unavailable'
    | 'gone'
    | 'already_claimed'
    | 'stale_context'
    | 'refused'

export interface PilotOrderCheckV1 {
    state: PilotOrderCheckStateV1
    order: PilotListedOrderV1 | null
    /** Set only when state is `refused`. */
    refusal: string | null
}

/**
 * The driver chose an order. Within the order-check threshold nothing more is
 * needed; otherwise a targeted confirmation is scheduled and the driver may
 * carry on, because the submission gate reads the order again.
 */
export async function checkPilotOrderV1(
    input: PilotTelegramPersonProofV1 & { externalOrderId: string; scopeKey: string; retry: boolean },
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
): Promise<PilotOrderCheckV1> {
    const resolved = await resolvePilotIdentityV1(input, port)
    if (!resolved.proven) return { state: 'refused', order: null, refusal: resolved.refusal }
    const view = await scopedSectionV1(resolved.identity, input.selectedExternalParkId, input.driverId, port, ingestion, now)
    if (!view.available) {
        return view.reason === 'catalogue_disabled'
            ? { state: 'unavailable', order: null, refusal: null }
            : { state: 'refused', order: null, refusal: view.reason }
    }
    const section = view.section
    if (input.scopeKey !== section.scope.scopeKey) return { state: 'stale_context', order: null, refusal: null }

    const order = section.orders.find((candidate) => candidate.externalOrderId === input.externalOrderId)
    if (!order) return { state: 'gone', order: null, refusal: null }
    const listed = pilotListedOrderV1(order, section.claimedOrderIds)
    if (listed.claimed) return { state: 'already_claimed', order: listed, refusal: null }
    if (freshForOrderCheckV1(order, section.dbNow)) return { state: 'fresh', order: listed, refusal: null }

    const state = await confirmationFollowUpV1(section.scope, order, section.dbNow, ingestion, input.retry)
    return { state, order: listed, refusal: null }
}

export interface PilotRefreshOutcomeV1 {
    status: 'scheduled' | 'joined' | 'recent' | 'unavailable' | 'failed' | 'refused'
    refusal: string | null
}

/**
 * Asks ingestion for one hot pass of the selected park. It returns as soon as
 * the pass is scheduled; the driver keeps using the local list.
 */
export async function requestPilotRefreshV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
): Promise<PilotRefreshOutcomeV1> {
    const resolved = await resolvePilotIdentityV1(proof, port)
    if (!resolved.proven) return { status: 'refused', refusal: resolved.refusal }
    const view = await scopedSectionV1(resolved.identity, proof.selectedExternalParkId, proof.driverId, port, ingestion, now)
    if (!view.available) {
        return view.reason === 'catalogue_disabled'
            ? { status: 'unavailable', refusal: null }
            : { status: 'refused', refusal: view.reason }
    }
    const outcome = await ingestion.requestHotRefresh(view.section.scope.externalParkId)
    if (outcome.status !== 'not_scheduled') return { status: outcome.status, refusal: null }
    switch (outcome.reason) {
        case 'hot_pass_recent':
        case 'refresh_in_flight':
            return { status: 'recent', refusal: null }
        case 'mode_not_write':
        case 'park_not_enabled':
            return { status: 'unavailable', refusal: null }
        default:
            return { status: 'failed', refusal: null }
    }
}

export type PilotSubmitOutcomeV1 =
    | { submitted: true; applicationId: string; amountKopecks: number; status: 'created' | 'replayed' }
    | { submitted: false; refusal: PilotSubmissionRefusalV1 | PilotViewRefusalV1 | PilotFreshnessRefusalV1 | string }

const SUBMIT_FOLLOW_UP_REFUSAL = {
    checking: 'order_confirmation_pending',
    not_confirmed: 'order_not_confirmed',
    check_failed: 'order_check_failed',
    unavailable: 'order_check_unavailable',
} as const

/**
 * Submits one claim.
 *
 * The identity is resolved once, so the claimed-order check and the C1 submit
 * see the same person. The scope and the catalogue are rebuilt here rather than
 * trusted from the conversation, so an order that stopped being eligible while
 * the driver was typing cannot be claimed, neither can an id the bot never
 * offered, and neither can an order listed for another park or profile.
 *
 * C1 is reached only with an order Yandex confirmed within the submission
 * threshold, and the time of that confirmation is what C1 records as verified.
 * An older order gets a targeted confirmation instead, and the driver submits
 * again once it lands.
 */
export async function submitPilotApplicationV1(
    input: PilotTelegramPersonProofV1 & {
        externalOrderId: string
        claimedRubles: number
        supportConfirmed: boolean
        attachmentFileId: string | null
        attachmentKind: string | null
        idempotencyKey: string
        scopeKey: string
    },
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
): Promise<PilotSubmitOutcomeV1> {
    const resolved = await resolvePilotIdentityV1(input, port)
    if (!resolved.proven) return { submitted: false, refusal: resolved.refusal }
    const identity = resolved.identity

    const view = await scopedSectionV1(identity, input.selectedExternalParkId, input.driverId, port, ingestion, now)
    if (!view.available) return { submitted: false, refusal: view.reason }
    const section = view.section
    if (input.scopeKey !== section.scope.scopeKey) return { submitted: false, refusal: 'stale_context' }

    const gate = decidePilotSubmissionV1({
        externalOrderId: input.externalOrderId,
        claimedRubles: input.claimedRubles,
        supportConfirmed: input.supportConfirmed,
        attachmentFileId: input.attachmentFileId,
        attachmentKind: input.attachmentKind,
    }, {
        catalogue: section.orders,
        alreadyClaimedOrderIds: section.claimedOrderIds,
        remainingBudgetKopecks: section.remainingBudgetKopecks,
    })
    if (!gate.accepted) return { submitted: false, refusal: gate.refusal }

    // The gate returned the catalogue row it accepted; this is the same row
    // with its provider evidence.
    const order = section.orders.find((candidate) => candidate.externalOrderId === gate.order.externalOrderId)
    if (!order) return { submitted: false, refusal: 'order_not_in_catalogue' }
    if (!freshForSubmissionV1(order, section.dbNow)) {
        const state = await confirmationFollowUpV1(section.scope, order, section.dbNow, ingestion, false)
        return { submitted: false, refusal: SUBMIT_FOLLOW_UP_REFUSAL[state] }
    }

    const result = await port.submitApplication({
        canonicalContactId: identity.canonicalContactId,
        lineage: identity.lineage,
        order,
        claimedRubles: gate.claimedRubles,
        telegramUserId: identity.telegramUserId,
        attachmentFileId: gate.attachmentFileId,
        attachmentKind: gate.attachmentKind,
        idempotencyKey: input.idempotencyKey,
        submittedAt: now,
    })
    if ('refusal' in result) return { submitted: false, refusal: result.refusal }
    return { submitted: true, ...result }
}

export { pilotDriverStatusV1 }
