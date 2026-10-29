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
import {
    withOwnerPilotAdmissionV1,
    type CompensationEligibilityFactsV1,
    type OwnerPilotAdmissionEntryV1,
} from './compensation-eligibility'
import {
    freshForOrderCheckV1,
    freshForSubmissionV1,
    pilotCatalogueStatusV1,
    pilotConfirmationFollowUpV1,
    pilotListedOrderV1,
    pilotDriverDayAllowedV1,
    pilotDriverDayQueryV1,
    pilotDriverDaySearchV1,
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
import {
    admitPilotContactLineageV1,
    type PilotContactLineageReadV1,
    type PilotLineageAdmissionRefusalV1,
} from './compensation-pilot-lineage'

/**
 * What the Telegram webhook proved before it called the pilot.
 *
 * The Telegram link names the Driver, read again by the webhook for every
 * request; that alone opens the section, decides eligibility and lists the
 * driver's own orders. A claim also needs the person C1 binds money to: when
 * the webhook proved a Contact for this Telegram account it passes it as
 * `contactId`, and the service re-checks the Contact-to-Driver confirmation and
 * resolves the person through Contacts' public reads. fleet_operations may not
 * read Telegram channel state. The Telegram user id is carried as submission
 * evidence; the webhook is the only caller that can prove it.
 *
 * The selected park is read by the webhook from the same Telegram link, in the
 * same request. The bot never supplies it.
 */
export interface PilotTelegramPersonProofV1 {
    telegramUserId: string
    driverId: string
    /** The Contact proven for this Telegram account, or null when the link stands alone. */
    contactId: string | null
    selectedExternalParkId: string | null
}

export type PilotMainDriverConfirmationV1 = 'confirmed' | 'not_confirmed' | 'busy'

/** Re-exported so every port implementor keeps one shape for the lineage read. */
export type { PilotContactLineageReadV1 }

export interface PilotDriverFactsV1 {
    externalParkId: string | null
    externalDriverProfileId: string | null
    facts: CompensationEligibilityFactsV1
}

/** The Driver the Telegram link names, with the facts eligibility reads. */
export interface PilotLinkedDriverV1 extends PilotDriverFactsV1 {
    telegramUserId: string
}

/** The person C1 binds a claim to. Only the monetary steps need one. */
export interface PilotMonetaryPersonV1 {
    /** Canonical contact proven for this Telegram account. */
    canonicalContactId: string
    /** The contacts C1 binds to the monetary person; the pilot admits one. */
    lineage: readonly string[]
}

export interface PilotDriverIdentityV1 extends PilotLinkedDriverV1, PilotMonetaryPersonV1 {}

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
    /**
     * Brings the proven Driver row's facts up to the provider's current state
     * unless they were confirmed recently, by a request for that row's own park
     * and profile (see DriverFactsRefresherV1). Absent: the stored facts decide.
     */
    ensureDriverFactsFresh?(driver: {
        driverId: string
        externalParkId: string
        externalDriverProfileId: string
        /** The row holds both the SMZ flag and the hire date. */
        factsStated: boolean
    }): Promise<'fresh' | 'refreshed' | 'unavailable'>
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

/** What one on-demand driver-day request came to within the wait it was given. */
export interface PilotDriverDayFetchV1 {
    /** complete: the provider answered; running: not yet; failed: no answer (code says why). */
    state: 'complete' | 'running' | 'failed'
    code: string | null
}

/**
 * What the pilot may ask of cash-order ingestion. Every call is local or only
 * schedules work, except fetchDriverDay, which waits for Yandex for a bounded
 * time chosen by the composition and reports `running` when that runs out.
 */
export interface CompensationPilotIngestionPortV1 {
    /** Mode, park enablement and catalogue progress, in database time. */
    readCatalogueFacts(externalParkId: string): Promise<PilotCatalogueFactsV1>
    requestHotRefresh(externalParkId: string): Promise<PilotScheduleOutcomeV1>
    /**
     * Asks ingestion to confirm one listed order with the provider. The stored
     * completion instant goes along so ingestion can admit the confirmation by
     * the order's own submission window, the same authority this service lists
     * the order by, rather than by the generic day horizon alone.
     */
    requestOrderConfirmation(input: {
        externalParkId: string
        dayKey: string
        externalOrderId: string
        providerBookedAt: Date | null
        endedAt: Date
        /** The proven profile: on demand, a confirmation asks for this driver's day only. */
        externalDriverProfileId?: string
    }): Promise<PilotScheduleOutcomeV1>
    readOrderConfirmation(input: {
        externalParkId: string
        dayKey: string
        externalOrderId: string
        externalDriverProfileId?: string
    }): Promise<PilotOrderConfirmationReadV1>
    /**
     * On demand only: one driver's completed cash orders of one business day,
     * asked of the provider and written when they verify. Absent outside that
     * mode; the section then answers a day as unavailable.
     */
    fetchDriverDay?(input: {
        externalParkId: string
        externalDriverProfileId: string
        dayKey: string
    }): Promise<PilotDriverDayFetchV1>
}

/**
 * The pilot port with the configured Owner pilot admissions attached to the
 * driver facts read. Every other method is the port's own, and nothing is
 * written: the admission lives in the configuration and in this read only.
 */
export function withOwnerPilotAdmissionPortV1(
    port: CompensationPilotPortV1,
    admissions: readonly OwnerPilotAdmissionEntryV1[],
): CompensationPilotPortV1 {
    if (admissions.length === 0) return port
    return {
        ...port,
        async findDriverFacts(driverId) {
            const row = await port.findDriverFacts(driverId)
            return row === null ? null : withOwnerPilotAdmissionV1(row, admissions)
        },
    }
}

export interface PilotScheduleOutcomeV1 {
    status: 'scheduled' | 'joined' | 'not_scheduled'
    reason: string | null
}

export const PILOT_VIEW_REFUSALS_V1 = [
    'identity_not_proven',
    'identity_needs_review',
    'identity_busy',
    // The programme admits the linked driver, but no person is proven to bind a claim to.
    'cash_person_unconfirmed',
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
        catalogueStatus: 'ready' | 'partial' | 'stale' | 'on_demand'
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

export type PilotDriverResolutionV1 =
    | { proven: true; driver: PilotLinkedDriverV1 }
    | { proven: false; refusal: 'identity_not_proven' | 'identity_busy' }

export type PilotPersonResolutionV1 =
    | { proven: true; person: PilotMonetaryPersonV1 }
    | { proven: false; refusal: 'cash_person_unconfirmed' | 'identity_busy' }

function exactText(value: unknown): value is string {
    return typeof value === 'string' && value !== '' && value === value.trim()
}

/**
 * How the shared lineage admission maps onto this surface's refusals. It is a
 * translation only: an unknown lineage and one joined to other contacts are
 * both reviewable, while a missing or non-canonical contact is simply unproven.
 * These are the exact refusals this path returned before the rule was shared.
 */
const PILOT_IDENTITY_LINEAGE_REFUSALS_V1: Record<
    PilotLineageAdmissionRefusalV1,
    'identity_not_proven' | 'identity_needs_review'
> = {
    lineage_missing: 'identity_not_proven',
    lineage_unresolvable: 'identity_needs_review',
    lineage_not_canonical: 'identity_not_proven',
    lineage_not_singleton: 'identity_needs_review',
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

    const admission = admitPilotContactLineageV1(
        proof.contactId,
        await port.resolveContactLineage(proof.contactId),
    )
    if (!admission.admitted) {
        return { proven: false, refusal: PILOT_IDENTITY_LINEAGE_REFUSALS_V1[admission.refusal] }
    }

    const read = await freshDriverFactsV1(proof.driverId, port)
    if ('refusal' in read) return { proven: false, refusal: read.refusal }
    const driver = read.driver

    return {
        proven: true,
        identity: {
            telegramUserId: proof.telegramUserId,
            canonicalContactId: admission.canonicalContactId,
            lineage: admission.lineage,
            externalParkId: driver.externalParkId,
            externalDriverProfileId: driver.externalDriverProfileId,
            facts: driver.facts,
        },
    }
}

/**
 * Reads the linked Driver row and, in a park Cash is live in, makes its facts
 * fresh first. Only the row's own park and profile are ever asked about:
 * nothing in the proof names what the provider is asked about.
 */
async function freshDriverFactsV1(
    driverId: string,
    port: CompensationPilotPortV1,
): Promise<{ driver: PilotDriverFactsV1 } | { refusal: 'identity_not_proven' | 'identity_busy' }> {
    let driver = await port.findDriverFacts(driverId)
    if (!driver) return { refusal: 'identity_not_proven' }
    if (port.ensureDriverFactsFresh && driver.externalParkId && driver.externalDriverProfileId) {
        const freshness = await port.ensureDriverFactsFresh({
            driverId,
            externalParkId: driver.externalParkId,
            externalDriverProfileId: driver.externalDriverProfileId,
            factsStated: driver.facts.isSelfEmployed !== null && driver.facts.parkHireDate !== null,
        })
        // Facts the provider could not confirm decide nothing; the driver retries.
        if (freshness === 'unavailable') return { refusal: 'identity_busy' }
        if (freshness === 'refreshed') {
            driver = await port.findDriverFacts(driverId)
            if (!driver) return { refusal: 'identity_not_proven' }
        }
    }
    return { driver }
}

/**
 * The Driver the Telegram link names. Nothing here needs a Contact: a linked
 * driver learns whether the programme admits them, and sees their own orders,
 * without any further confirmation.
 */
export async function resolvePilotDriverV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
): Promise<PilotDriverResolutionV1> {
    if (!exactText(proof.telegramUserId) || !exactText(proof.driverId)) {
        return { proven: false, refusal: 'identity_not_proven' }
    }
    const read = await freshDriverFactsV1(proof.driverId, port)
    if ('refusal' in read) return { proven: false, refusal: read.refusal }
    return {
        proven: true,
        driver: {
            telegramUserId: proof.telegramUserId,
            externalParkId: read.driver.externalParkId,
            externalDriverProfileId: read.driver.externalDriverProfileId,
            facts: read.driver.facts,
        },
    }
}

/**
 * The person a claim is bound to, for the monetary steps only: the Contact
 * proven for this Telegram account, confirmed as this Driver's person, with a
 * lineage C1 can bind (see resolvePilotIdentityV1 for why only one contact).
 * Without one the driver still sees the programme, but no claim reaches C1:
 * money is never bound to a person Contacts has not proven, and no person is
 * made up from the Driver or the Telegram account instead.
 */
export async function resolvePilotPersonV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
): Promise<PilotPersonResolutionV1> {
    if (!exactText(proof.contactId) || !exactText(proof.driverId)) {
        return { proven: false, refusal: 'cash_person_unconfirmed' }
    }
    const confirmation = await port.confirmMainDriver(proof.contactId, proof.driverId)
    if (confirmation === 'busy') return { proven: false, refusal: 'identity_busy' }
    if (confirmation !== 'confirmed') return { proven: false, refusal: 'cash_person_unconfirmed' }
    const admission = admitPilotContactLineageV1(
        proof.contactId,
        await port.resolveContactLineage(proof.contactId),
    )
    if (!admission.admitted) return { proven: false, refusal: 'cash_person_unconfirmed' }
    return {
        proven: true,
        person: { canonicalContactId: admission.canonicalContactId, lineage: admission.lineage },
    }
}

type PilotSubjectV1 =
    | { proven: true; driver: PilotLinkedDriverV1; person: PilotMonetaryPersonV1 | null }
    | { proven: false; refusal: 'identity_not_proven' | 'identity_busy' }

/**
 * The driver first, so eligibility never waits on Contacts; then the person,
 * when there is one. A Contacts lock is a retry, never a verdict.
 */
async function resolvePilotSubjectV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
): Promise<PilotSubjectV1> {
    const driver = await resolvePilotDriverV1(proof, port)
    if (!driver.proven) return driver
    const person = await resolvePilotPersonV1(proof, port)
    if (!person.proven && person.refusal === 'identity_busy') return { proven: false, refusal: 'identity_busy' }
    return { proven: true, driver: driver.driver, person: person.proven ? person.person : null }
}

interface ScopedSectionV1 {
    scope: PilotScopeV1
    firstMonthKey: string
    remainingBudgetKopecks: number
    catalogueStatus: 'ready' | 'partial' | 'stale' | 'on_demand'
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
 * Everything the Telegram surface may act on for one linked driver, rebuilt
 * from the database on every request. Local reads only. Applications and
 * claims belong to the person, so without one there are none to show.
 */
async function scopedSectionV1(
    identity: PilotLinkedDriverV1,
    person: PilotMonetaryPersonV1 | null,
    selectedExternalParkId: string | null,
    driverId: string,
    port: CompensationPilotPortV1,
    ingestion: CompensationPilotIngestionPortV1,
    now: Date,
): Promise<ScopedSectionResultV1> {
    const applications = person ? await port.findDriverApplications(person.lineage) : []

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
            claimedOrderIds: person ? await port.findClaimedOrderIds(person.lineage) : [],
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
    const resolved = await resolvePilotSubjectV1(proof, port)
    if (!resolved.proven) return { available: false, reason: resolved.refusal, applications: [] }
    // The public section is a plain view built here, never a value handed back
    // from a helper that holds the port.
    const view = await scopedSectionV1(resolved.driver, resolved.person, proof.selectedExternalParkId, proof.driverId, port, ingestion, now)
    if (!view.available) return { available: false, reason: view.reason, applications: view.applications }
    // The programme admits this driver, but no claim could be bound to a person:
    // no list is offered, and no provider is asked about a day.
    if (resolved.person === null) return { available: false, reason: 'cash_person_unconfirmed', applications: [] }

    let section = view.section
    let applications = view.applications
    const query = typeof options.search === 'string' ? options.search.trim() : ''
    const dayKey = section.catalogueStatus === 'on_demand' && query !== '' ? pilotDriverDayQueryV1(query) : null
    let search: PilotOrderSearchV1 | null = null
    if (dayKey !== null) {
        // Every rule above has already passed: the person is proven, the driver
        // is eligible and the park and profile are the proven ones. Only now,
        // and only for a day the driver may claim, is the provider asked.
        if (!pilotDriverDayAllowedV1(dayKey, section.firstMonthKey, section.dbNow)) {
            search = pilotDriverDaySearchV1([], dayKey, 'date_not_allowed')
        } else {
            const fetched: PilotDriverDayFetchV1 = ingestion.fetchDriverDay
                ? await ingestion.fetchDriverDay({
                    externalParkId: section.scope.externalParkId,
                    externalDriverProfileId: section.scope.externalDriverProfileId,
                    dayKey,
                })
                : { state: 'failed', code: 'driver_day_unavailable' }
            // Rebuilt from storage: whatever the answer wrote is listed by the
            // same catalogue rules every other list uses.
            const rebuilt = await scopedSectionV1(resolved.driver, resolved.person, proof.selectedExternalParkId, proof.driverId, port, ingestion, now)
            if (!rebuilt.available) return { available: false, reason: rebuilt.reason, applications: rebuilt.applications }
            section = rebuilt.section
            applications = rebuilt.applications
            const listed = section.orders.map((order) => pilotListedOrderV1(order, section.claimedOrderIds))
            search = pilotDriverDaySearchV1(
                listed,
                dayKey,
                fetched.state === 'complete' ? 'date' : fetched.state === 'running' ? 'date_checking' : 'date_unavailable',
            )
        }
    }
    const orders = section.orders.map((order) => pilotListedOrderV1(order, section.claimedOrderIds))
    if (search === null && query !== '') search = pilotOrderSearchV1(orders, query)
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
        applications,
    }
}

async function confirmationFollowUpV1(
    section: { scope: PilotScopeV1; catalogueStatus: ScopedSectionV1['catalogueStatus'] },
    order: PilotCatalogueOrderV1,
    dbNow: Date,
    ingestion: CompensationPilotIngestionPortV1,
    retry: boolean,
): Promise<'checking' | 'not_confirmed' | 'check_failed' | 'unavailable'> {
    const scope = section.scope
    const dayKey = compensationBusinessDayKeyV1(order.endedAt)
    // On demand an order is confirmed through its own driver's day, so the
    // proven profile goes along; every other mode keeps the park-day request.
    const driver = section.catalogueStatus === 'on_demand' ? { externalDriverProfileId: scope.externalDriverProfileId } : {}
    const read = await ingestion.readOrderConfirmation({
        externalParkId: scope.externalParkId,
        dayKey,
        externalOrderId: order.externalOrderId,
        ...driver,
    })
    const next = pilotConfirmationFollowUpV1(read, order, dbNow, { retry })
    if (next !== 'request') return next
    return pilotScheduleFollowUpV1(await ingestion.requestOrderConfirmation({
        externalParkId: scope.externalParkId,
        dayKey,
        externalOrderId: order.externalOrderId,
        providerBookedAt: order.providerBookedAt,
        endedAt: order.endedAt,
        ...driver,
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
    const resolved = await resolvePilotSubjectV1(input, port)
    if (!resolved.proven) return { state: 'refused', order: null, refusal: resolved.refusal }
    const view = await scopedSectionV1(resolved.driver, resolved.person, input.selectedExternalParkId, input.driverId, port, ingestion, now)
    if (!view.available) {
        return view.reason === 'catalogue_disabled'
            ? { state: 'unavailable', order: null, refusal: null }
            : { state: 'refused', order: null, refusal: view.reason }
    }
    // A check leads only to a claim, and a claim needs the person.
    if (resolved.person === null) return { state: 'refused', order: null, refusal: 'cash_person_unconfirmed' }
    const section = view.section
    if (input.scopeKey !== section.scope.scopeKey) return { state: 'stale_context', order: null, refusal: null }

    const order = section.orders.find((candidate) => candidate.externalOrderId === input.externalOrderId)
    if (!order) return { state: 'gone', order: null, refusal: null }
    const listed = pilotListedOrderV1(order, section.claimedOrderIds)
    if (listed.claimed) return { state: 'already_claimed', order: listed, refusal: null }
    if (freshForOrderCheckV1(order, section.dbNow)) return { state: 'fresh', order: listed, refusal: null }

    const state = await confirmationFollowUpV1(section, order, section.dbNow, ingestion, input.retry)
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
    const resolved = await resolvePilotSubjectV1(proof, port)
    if (!resolved.proven) return { status: 'refused', refusal: resolved.refusal }
    const view = await scopedSectionV1(resolved.driver, resolved.person, proof.selectedExternalParkId, proof.driverId, port, ingestion, now)
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
    const resolved = await resolvePilotSubjectV1(input, port)
    if (!resolved.proven) return { submitted: false, refusal: resolved.refusal }

    const view = await scopedSectionV1(resolved.driver, resolved.person, input.selectedExternalParkId, input.driverId, port, ingestion, now)
    if (!view.available) return { submitted: false, refusal: view.reason }
    // Money is bound only to a person Contacts proved; without one nothing reaches C1.
    if (resolved.person === null) return { submitted: false, refusal: 'cash_person_unconfirmed' }
    const person = resolved.person
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
        const state = await confirmationFollowUpV1(section, order, section.dbNow, ingestion, false)
        return { submitted: false, refusal: SUBMIT_FOLLOW_UP_REFUSAL[state] }
    }

    const result = await port.submitApplication({
        canonicalContactId: person.canonicalContactId,
        lineage: person.lineage,
        order,
        claimedRubles: gate.claimedRubles,
        telegramUserId: resolved.driver.telegramUserId,
        attachmentFileId: gate.attachmentFileId,
        attachmentKind: gate.attachmentKind,
        idempotencyKey: input.idempotencyKey,
        submittedAt: now,
    })
    if ('refusal' in result) return { submitted: false, refusal: result.refusal }
    return { submitted: true, ...result }
}

export { pilotDriverStatusV1 }

// ── Freshness of the proven driver's eligibility facts ───────────────────────

/**
 * Cash must not depend on the nightly sync of whole parks, which a large park
 * can fail for days. The facts a decision reads (the park-SMZ flag and the
 * park hire date) decide on their own only when this process confirmed them
 * with the provider within the TTL. A fact the provider did not state decides
 * only within UNSTATED_RECHECK_MS of that answer. The row's own observation
 * stamp is never enough. Otherwise one targeted request for exactly the proven
 * park and profile runs first. A refresh that cannot complete leaves the
 * driver with a retry, never with a decision on facts the provider did not
 * confirm.
 *
 * Load on the provider is bounded here, per process (Gravity runs one):
 *   - a driver waits at most WAIT_MS; the request itself finishes in the
 *     background and the next tap reads its result;
 *   - concurrent taps for one profile join the request already in flight;
 *   - a failed profile is not asked again for RETRY_AFTER_FAILURE_MS;
 *   - HTTP 429 pauses the whole park for Retry-After, or for a cooldown that
 *     doubles on every repeat, capped;
 *   - at most MAX_IN_FLIGHT refreshes run at once across all drivers.
 */
export const DRIVER_FACTS_FRESHNESS_V1 = Object.freeze({
    /**
     * Twelve hours keeps a decision within the provider's state of the same day
     * (the SMZ flag and the hire date rarely change) at no more than two
     * requests per driver per day.
     */
    TTL_MS: 12 * 60 * 60 * 1000,
    /** After the provider answered without a fact, it is not asked again for that profile for this long. */
    UNSTATED_RECHECK_MS: 10 * 60 * 1000,
    /** Under the bot's 15 s timeout with room for the rest of the request. */
    WAIT_MS: 7_000,
    RETRY_AFTER_FAILURE_MS: 60_000,
    RATE_LIMIT_COOLDOWN_MS: 60_000,
    RATE_LIMIT_COOLDOWN_MAX_MS: 15 * 60 * 1000,
    MAX_IN_FLIGHT: 3,
    /** Per-profile memory is pruned past this size; entries older than their window carry no state. */
    MAX_REMEMBERED_PROFILES: 1_000,
})

const FRESHNESS = DRIVER_FACTS_FRESHNESS_V1

export type DriverFactsFreshnessV1 = 'fresh' | 'refreshed' | 'unavailable'

export interface DriverFactsRefreshTargetV1 {
    externalParkId: string
    externalDriverProfileId: string
}

export type DriverFactsRefreshResultV1 =
    | { status: 'refreshed' }
    | { status: 'not_returned' }
    | { status: 'rate_limited'; retryAfterMs: number | null }
    | { status: 'failed'; code: string }

export interface DriverFactsRefreshPortsV1 {
    refresh(target: DriverFactsRefreshTargetV1): Promise<DriverFactsRefreshResultV1>
    nowMs(): number
    sleep(ms: number): Promise<void>
}

export class DriverFactsRefresherV1 {
    private readonly inFlight = new Map<string, Promise<boolean>>()
    private readonly lastConfirmedAt = new Map<string, number>()
    private readonly lastFailureAt = new Map<string, number>()
    private readonly parkCooldownUntil = new Map<string, number>()
    private readonly parkRateLimitStrikes = new Map<string, number>()

    constructor(private readonly ports: DriverFactsRefreshPortsV1) {}

    /** `factsStated`: the row holds both the SMZ flag and the hire date. */
    async ensureFresh(target: DriverFactsRefreshTargetV1, factsStated: boolean): Promise<DriverFactsFreshnessV1> {
        const now = this.ports.nowMs()
        const key = `${target.externalParkId}:${target.externalDriverProfileId}`
        const confirmedAt = this.lastConfirmedAt.get(key)
        const trustMs = factsStated ? FRESHNESS.TTL_MS : FRESHNESS.UNSTATED_RECHECK_MS
        if (confirmedAt !== undefined && now - confirmedAt < trustMs) return 'fresh'
        let pending = this.inFlight.get(key)
        if (pending === undefined) {
            if ((this.parkCooldownUntil.get(target.externalParkId) ?? 0) > now) return 'unavailable'
            const failedAt = this.lastFailureAt.get(key)
            if (failedAt !== undefined && now - failedAt < FRESHNESS.RETRY_AFTER_FAILURE_MS) return 'unavailable'
            if (this.inFlight.size >= FRESHNESS.MAX_IN_FLIGHT) return 'unavailable'
            pending = this.run(key, target)
            this.inFlight.set(key, pending)
        }
        const settled = await Promise.race([pending, this.ports.sleep(FRESHNESS.WAIT_MS).then(() => null)])
        return settled === true ? 'refreshed' : 'unavailable'
    }

    private async run(key: string, target: DriverFactsRefreshTargetV1): Promise<boolean> {
        try {
            const result: DriverFactsRefreshResultV1 = await this.ports.refresh(target)
                .catch(() => ({ status: 'failed' as const, code: 'refresh_threw' }))
            const now = this.ports.nowMs()
            if (result.status === 'refreshed') {
                this.lastFailureAt.delete(key)
                this.parkRateLimitStrikes.delete(target.externalParkId)
                this.remember(this.lastConfirmedAt, key, now, FRESHNESS.TTL_MS)
                return true
            }
            this.remember(this.lastFailureAt, key, now, FRESHNESS.RETRY_AFTER_FAILURE_MS)
            if (result.status === 'rate_limited') {
                const strikes = (this.parkRateLimitStrikes.get(target.externalParkId) ?? 0) + 1
                this.parkRateLimitStrikes.set(target.externalParkId, strikes)
                const backoff = FRESHNESS.RATE_LIMIT_COOLDOWN_MS * 2 ** Math.min(strikes - 1, 8)
                const pause = Math.min(FRESHNESS.RATE_LIMIT_COOLDOWN_MAX_MS, Math.max(result.retryAfterMs ?? 0, backoff))
                this.parkCooldownUntil.set(target.externalParkId, now + pause)
            }
            return false
        } finally {
            this.inFlight.delete(key)
        }
    }

    private remember(map: Map<string, number>, key: string, now: number, windowMs: number): void {
        if (map.size >= FRESHNESS.MAX_REMEMBERED_PROFILES) {
            for (const [entry, at] of map) {
                if (now - at >= windowMs) map.delete(entry)
            }
        }
        map.set(key, now)
    }
}
