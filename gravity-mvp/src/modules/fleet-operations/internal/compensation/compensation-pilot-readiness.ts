/**
 * Whether the cash-compensation pilot can actually be run against real data.
 *
 * This is a proof, not a switch. Nothing here activates anything, writes
 * anything or asks a provider anything; it reads facts that other authorities
 * already own and says whether they line up on one real person.
 *
 * There are two gates, and collapsing them would make the answer useless:
 *
 *   PILOT CANDIDATE READY  a real driver exists whom the pilot may serve at
 *                          all — park scope, provider identifiers, park-SMZ,
 *                          first calendar month, a bot link on the same park,
 *                          and one canonical person Contacts confirms.
 *   PILOT INPUT READY      that same driver additionally has something to
 *                          claim right now — authoritative park, a ready
 *                          catalogue, a fresh unclaimed order in their exact
 *                          scope, and a budget period that can cover a claim.
 *
 * A candidate can be ready while no budget exists, ingestion is off, there is
 * no catalogue and no order has ever been seen: those are Gate 2's business.
 * Every refusal is a bounded code, and "the feature is not available" is never
 * reported as "there is nothing to claim today".
 *
 * Every rule below is delegated. Eligibility is compensationPilotEligibilityV1,
 * catalogue membership is cashOrderCatalogueV1, catalogue trust is
 * pilotCatalogueStatusV1, freshness is freshForSubmissionV1 and claimability is
 * pilotOrderClaimableWithinBudgetV1 — the same functions the live pilot uses.
 * Nothing here re-derives a threshold, a month or an amount.
 */

import { cashOrderCatalogueV1 } from './compensation-cash-order-ingestion'
import {
    compensationPilotEligibilityV1,
    type CompensationEligibilityFactsV1,
} from './compensation-eligibility'
import {
    pilotOrderClaimableWithinBudgetV1,
    remainingBudgetKopecksV1,
} from './compensation-pilot-flow'
import {
    admitPilotContactLineageV1,
    type PilotContactLineageReadV1,
    type PilotLineageAdmissionRefusalV1,
} from './compensation-pilot-lineage'
import {
    freshForSubmissionV1,
    type PilotCatalogueOrderV1,
    type PilotCatalogueStatusV1,
} from './compensation-pilot-selection'

/** Why one driver cannot be a pilot candidate at all. */
export const PILOT_CANDIDATE_REFUSALS_V1 = [
    'pilot_park_out_of_scope',
    'driver_profile_id_missing',
    // The four below are compensation-eligibility's own codes, reused verbatim.
    'self_employment_unknown',
    'not_self_employed',
    'hire_date_unknown',
    'outside_first_calendar_month',
    'telegram_link_missing',
    'telegram_park_missing',
    'telegram_park_mismatch',
    'contact_missing',
    'contact_not_confirmed',
    'contact_busy',
    'contact_lineage_missing',
    'contact_lineage_unresolvable',
    /** Resolved, but not to this contact alone — the pilot admits exactly one. */
    'contact_lineage_ambiguous',
] as const
export type PilotCandidateRefusalV1 = typeof PILOT_CANDIDATE_REFUSALS_V1[number]

/** Why a ready candidate still has no usable pilot input. */
export const PILOT_INPUT_REFUSALS_V1 = [
    'park_authority_failed',
    'catalogue_disabled',
    'catalogue_stale',
    'catalogue_partial',
    /** The catalogue is trustworthy and this driver simply has no orders in it. */
    'no_cash_orders',
    'no_fresh_submission_orders',
    'all_fresh_orders_claimed',
    'budget_period_missing',
    'budget_exhausted_or_insufficient',
] as const
export type PilotInputRefusalV1 = typeof PILOT_INPUT_REFUSALS_V1[number]

/** Exactly the Driver fields readiness is allowed to read. */
export interface PilotCandidateDriverV1 {
    driverId: string
    /** Candidate contact identifier only; Contacts remains the person authority. */
    contactId: string | null
    externalParkId: string | null
    externalDriverProfileId: string | null
    facts: CompensationEligibilityFactsV1
}

export type PilotCandidateFactsGateV1 =
    | {
        passed: true
        driverId: string
        contactId: string
        externalParkId: string
        externalDriverProfileId: string
        firstMonthKey: string
        facts: CompensationEligibilityFactsV1
    }
    | { passed: false; driverId: string; reason: PilotCandidateRefusalV1; firstMonthKey: string | null }

/**
 * Everything decidable about a candidate from the Driver row alone.
 *
 * It runs before any Telegram or Contacts read so a driver outside the pilot
 * park scope costs nothing, and so an ineligible driver is never looked up in
 * another owner's data.
 *
 * `isSelfEmployed` stays decisive: an `employmentType` of `selfemployed` with a
 * boolean that is not exactly true does not pass, because the boolean is what
 * the park actually stated.
 */
export function pilotCandidateFactsGateV1(
    driver: PilotCandidateDriverV1,
    pilotParkIds: readonly string[],
    now: Date,
): PilotCandidateFactsGateV1 {
    const refuse = (reason: PilotCandidateRefusalV1, firstMonthKey: string | null = null): PilotCandidateFactsGateV1 =>
        ({ passed: false, driverId: driver.driverId, reason, firstMonthKey })

    const externalParkId = driver.externalParkId
    if (externalParkId === null || !pilotParkIds.includes(externalParkId)) {
        return refuse('pilot_park_out_of_scope')
    }
    const externalDriverProfileId = driver.externalDriverProfileId
    if (externalDriverProfileId === null || externalDriverProfileId.trim() === '') {
        return refuse('driver_profile_id_missing')
    }

    const eligibility = compensationPilotEligibilityV1(driver.facts, now)
    if (!eligibility.eligible) {
        return refuse(eligibility.reason, eligibility.firstMonthKey)
    }

    // Read after eligibility so a driver who could never be served is not
    // reported as a contact problem.
    const contactId = driver.contactId
    if (contactId === null || contactId.trim() === '') {
        return refuse('contact_missing', eligibility.firstMonthKey)
    }

    return {
        passed: true,
        driverId: driver.driverId,
        contactId,
        externalParkId,
        externalDriverProfileId,
        firstMonthKey: eligibility.firstMonthKey,
        facts: driver.facts,
    }
}

/** The bot link, as much of it as crosses the Telegram boundary. */
export interface PilotCandidateTelegramLinkV1 {
    activeParkId: string | null
}

export type PilotCandidateMainDriverConfirmationV1 = 'confirmed' | 'not_confirmed' | 'busy'

/** Contacts' lineage read; the shared admission rule owns its shape. */
export type PilotCandidateLineageV1 = PilotContactLineageReadV1

/** What the other owners answered about one prescreened candidate. */
export interface PilotCandidateIdentityReadV1 {
    /** Null when telegram_channel reported no link for this driver. */
    telegramLink: PilotCandidateTelegramLinkV1 | null
    mainDriverConfirmation: PilotCandidateMainDriverConfirmationV1
    lineage: PilotCandidateLineageV1
}

export interface PilotCandidateV1 {
    driverId: string
    externalParkId: string
    externalDriverProfileId: string
    canonicalContactId: string
    /** The contacts C1 would bind; the pilot admits exactly one. */
    lineage: readonly string[]
    firstMonthKey: string
    facts: CompensationEligibilityFactsV1
}

export type PilotCandidateGateV1 =
    | { ready: true; candidate: PilotCandidateV1 }
    | { ready: false; driverId: string; reason: PilotCandidateRefusalV1; firstMonthKey: string | null }

/**
 * How the shared lineage admission maps onto readiness' reason codes. An
 * operator needs "Contacts could not answer" told apart from "Contacts answered
 * about a different or a joined person", so the two unusable resolved shapes
 * share one code and the unknowns keep their own.
 */
const PILOT_READINESS_LINEAGE_REASONS_V1: Record<PilotLineageAdmissionRefusalV1, PilotCandidateRefusalV1> = {
    lineage_missing: 'contact_lineage_missing',
    lineage_unresolvable: 'contact_lineage_unresolvable',
    lineage_not_canonical: 'contact_lineage_ambiguous',
    lineage_not_singleton: 'contact_lineage_ambiguous',
}

/**
 * Gate 1. The bot link must name the same park the Driver profile proves: a
 * link on another park is a different scope, and the pilot never serves a
 * profile from a park the driver did not select.
 *
 * The person is Contacts' answer and nothing else. A held ownership fence is an
 * unknown, so it refuses as busy rather than as "not this person".
 */
export function pilotCandidateGateV1(
    prescreened: Extract<PilotCandidateFactsGateV1, { passed: true }>,
    read: PilotCandidateIdentityReadV1,
): PilotCandidateGateV1 {
    const refuse = (reason: PilotCandidateRefusalV1): PilotCandidateGateV1 =>
        ({ ready: false, driverId: prescreened.driverId, reason, firstMonthKey: prescreened.firstMonthKey })

    if (read.telegramLink === null) return refuse('telegram_link_missing')
    const activeParkId = read.telegramLink.activeParkId
    if (activeParkId === null || activeParkId.trim() === '') return refuse('telegram_park_missing')
    if (activeParkId !== prescreened.externalParkId) return refuse('telegram_park_mismatch')

    if (read.mainDriverConfirmation === 'busy') return refuse('contact_busy')
    if (read.mainDriverConfirmation !== 'confirmed') return refuse('contact_not_confirmed')

    // The same rule the Telegram submission path admits a person by, so
    // readiness can never report a driver that path would refuse.
    const admission = admitPilotContactLineageV1(prescreened.contactId, read.lineage)
    if (!admission.admitted) return refuse(PILOT_READINESS_LINEAGE_REASONS_V1[admission.refusal])

    return {
        ready: true,
        candidate: {
            driverId: prescreened.driverId,
            externalParkId: prescreened.externalParkId,
            externalDriverProfileId: prescreened.externalDriverProfileId,
            canonicalContactId: admission.canonicalContactId,
            lineage: admission.lineage,
            firstMonthKey: prescreened.firstMonthKey,
            facts: prescreened.facts,
        },
    }
}

/** What Gate 2 must be told about one Gate-1 candidate's park and orders. */
export interface PilotInputReadV1 {
    parkAuthority: 'authoritative' | 'failed'
    catalogueStatus: PilotCatalogueStatusV1
    /** Database time, the same clock the catalogue's observedAt is written on. */
    dbNow: Date
    /** Every stored order the population read returned for this driver's scope. */
    orders: readonly PilotCatalogueOrderV1[]
    claimedOrderIds: readonly string[]
    budgetPeriod: { limitKopecks: number; reservedKopecks: number; settledKopecks: number } | null
}

export interface PilotInputCountsV1 {
    /** Orders in the driver's exact scope and first calendar month. */
    catalogueOrderCount: number
    freshOrderCount: number
    freshUnclaimedOrderCount: number
    /** Fresh, unclaimed and affordable under the current budget. */
    claimableOrderCount: number
    remainingBudgetKopecks: number
}

export type PilotInputGateV1 =
    | { ready: true; counts: PilotInputCountsV1 }
    | { ready: false; reason: PilotInputRefusalV1; counts: PilotInputCountsV1 }

/**
 * Gate 2. Every narrowing step is reported separately, because an operator
 * needs to know which one emptied the list: a park that ingestion does not
 * write is a deployment state, orders that are all claimed is a data state, and
 * a missing budget period is an owner action still outstanding.
 *
 * Orders are re-confined to the exact (park, profile) scope here even though
 * the read is already scoped, so a wider read can never make two unrelated
 * facts look like one ready candidate.
 */
export function pilotInputGateV1(
    candidate: PilotCandidateV1,
    read: PilotInputReadV1,
    now: Date,
): PilotInputGateV1 {
    const exactScope = read.orders.filter((order) => (
        order.externalParkId === candidate.externalParkId
        && order.externalDriverProfileId === candidate.externalDriverProfileId
    ))
    // The same month filter the driver's own list uses, so readiness and the
    // bot can never disagree about which orders belong to the pilot window.
    const catalogue = cashOrderCatalogueV1(candidate.facts, exactScope, now)
    const catalogueOrders = catalogue.eligible ? catalogue.orders : []
    const fresh = catalogueOrders.filter((order) => freshForSubmissionV1(order, read.dbNow))
    const freshUnclaimed = fresh.filter((order) => !read.claimedOrderIds.includes(order.externalOrderId))
    const remainingBudgetKopecks = read.budgetPeriod === null ? 0 : remainingBudgetKopecksV1(read.budgetPeriod)
    const claimable = read.budgetPeriod === null
        ? []
        : freshUnclaimed.filter((order) => pilotOrderClaimableWithinBudgetV1(order, remainingBudgetKopecks))

    const counts: PilotInputCountsV1 = {
        catalogueOrderCount: catalogueOrders.length,
        freshOrderCount: fresh.length,
        freshUnclaimedOrderCount: freshUnclaimed.length,
        claimableOrderCount: claimable.length,
        remainingBudgetKopecks,
    }
    const refuse = (reason: PilotInputRefusalV1): PilotInputGateV1 => ({ ready: false, reason, counts })

    if (read.parkAuthority !== 'authoritative') return refuse('park_authority_failed')
    if (read.catalogueStatus === 'disabled') return refuse('catalogue_disabled')
    if (read.catalogueStatus === 'stale') return refuse('catalogue_stale')
    if (read.catalogueStatus === 'partial') return refuse('catalogue_partial')
    if (catalogueOrders.length === 0) return refuse('no_cash_orders')
    if (fresh.length === 0) return refuse('no_fresh_submission_orders')
    if (freshUnclaimed.length === 0) return refuse('all_fresh_orders_claimed')
    if (read.budgetPeriod === null) return refuse('budget_period_missing')
    if (claimable.length === 0) return refuse('budget_exhausted_or_insufficient')

    return { ready: true, counts }
}
