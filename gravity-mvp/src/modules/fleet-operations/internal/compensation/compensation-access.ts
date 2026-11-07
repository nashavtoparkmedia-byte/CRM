/**
 * Cash access: whether a proven person may claim, for which orders, and the
 * true reason when not.
 *
 * Nothing calls this yet. The live pilot still decides through
 * compensation-eligibility alone; this module composes that same standard rule
 * with the two new kinds of access, so that once it is wired the standard
 * programme answers exactly as it does today.
 *
 * The decision runs in this order:
 *
 *   identity      a blocker always refuses, before anything else is read
 *   manual deny   an authorised denial closes manual and referral access.
 *                 Whether it also closes the standard programme (P6), and
 *                 whether a denied person is still offered the referral
 *                 programme (P5), are the Owner's decisions; until they are
 *                 made the answer says so instead of choosing
 *   access        a manual grant, a referral entitlement and the standard
 *                 first month each open their own order window; a driver may
 *                 hold several, and an order is claimable under any of them
 *   refusal       otherwise the standard programme's own reason, then the
 *                 missing entitlement, with an offer to invite a park-SMZ
 *
 * Referral and manual access begin at the instant they were confirmed and
 * never earlier: the records hold no other start, so nothing can be backdated.
 * A manual record counts only when a signed staff session holding the access
 * capability made it. Anything else, the unsigned CRM user selector above all,
 * changes nothing in either direction.
 *
 * This module decides who may claim and which orders. It never touches money:
 * the cap, the one order per day, the monthly budget, provider confirmation,
 * the submission deadline and idempotency stay with C1, for every basis alike.
 * A referral or manual window has no end, so its orders are claimable month
 * after month, each against its own month's budget and deadline; the order
 * catalogue below is the one the Cash section lists from once it is wired.
 */

import {
    compensationCalendarMonthV1,
    compensationDayEndInstantV1,
    compensationDayStartInstantV1,
    compensationMonthEndInstantV1,
    compensationMonthStartInstantV1,
    compensationPeriodKeyV1,
    parseCompensationBusinessDayKeyV1,
} from './compensation-calendar'
import { cashOrderSubmissionOpenV1, type StoredCashOrderV1 } from './compensation-cash-order-ingestion'
import {
    compensationPilotAdmissionBasisV1,
    compensationPilotEligibilityV1,
    compensationPilotFirstMonthV1,
    type CompensationEligibilityFactsV1,
} from './compensation-eligibility'

/** Refusals of the person proof. Each ends the decision before access is read. */
export const CASH_ACCESS_IDENTITY_REFUSALS_V1 = [
    'identity_not_proven',
    'identity_needs_review',
    'identity_busy',
    'authority_refused',
] as const

export type CashAccessIdentityRefusalV1 = typeof CASH_ACCESS_IDENTITY_REFUSALS_V1[number]

export type CashAccessIdentityV1 =
    | { proven: true }
    | { proven: false; refusal: CashAccessIdentityRefusalV1 }

/** What a signed staff session must hold to grant or deny Cash access. */
export const CASH_ACCESS_MANAGE_CAPABILITY_V1 = 'cash.access.manage'

/**
 * Who made a manual record. Only a signed staff session can carry authority.
 * The other kinds are named so that a record made through them is recognised
 * and set aside, never trusted.
 */
export type CashAccessActorV1 =
    | { kind: 'signed_staff_session'; principalId: string; capabilities: readonly string[] }
    | { kind: 'crm_user' | 'integration_admin' | 'system'; principalId: string }

export interface CashReferralEntitlementV1 {
    /** When the qualifying invitation was confirmed. Access starts here. */
    confirmedAt: Date
    /** When an authorised revoke closed it; null while it stands. */
    revokedAt: Date | null
}

/**
 * The person's latest manual decision. A revoked grant or a lifted denial
 * leaves no record here at all.
 */
export interface CashManualAccessV1 {
    decision: 'grant' | 'deny'
    decidedAt: Date
    actor: CashAccessActorV1
}

/**
 * The two Owner decisions this design leaves open. Absent means undecided.
 */
export interface CashAccessOwnerPolicyV1 {
    /** P6: does a manual denial also close the standard first-month programme? */
    manualDenyClosesStandardProgramme?: boolean
    /** P5: is a manually denied person still offered the referral programme? */
    referralOfferAfterManualDeny?: boolean
}

export interface CashAccessInputV1 {
    identity: CashAccessIdentityV1
    /**
     * The standard programme's facts for the proven profile; null when the
     * provider could not confirm them now.
     */
    standardFacts: CompensationEligibilityFactsV1 | null
    referral: CashReferralEntitlementV1 | null
    manual: CashManualAccessV1 | null
    ownerPolicy: CashAccessOwnerPolicyV1
    /** The database clock the whole decision is taken at. */
    at: Date
}

export type CashAccessBasisV1 = 'manual_grant' | 'referral' | 'park_smz' | 'owner_pilot_admission'

export interface CashAccessWindowV1 {
    basis: CashAccessBasisV1
    /** The earliest order completion this basis covers. */
    ordersFrom: Date
    /** The exclusive end of the completions it covers; null when it has none. */
    ordersUntil: Date | null
}

export const CASH_ACCESS_REFUSAL_REASONS_V1 = [
    ...CASH_ACCESS_IDENTITY_REFUSALS_V1,
    'manual_deny',
    'not_self_employed',
    'outside_first_calendar_month',
    'self_employment_unknown',
    'hire_date_unknown',
    'standard_facts_unavailable',
    'no_entitlement',
    'referral_access_revoked',
] as const

export type CashAccessRefusalReasonV1 = typeof CASH_ACCESS_REFUSAL_REASONS_V1[number]

/**
 * What each reason states. Only `stated` and `decided` are verdicts about the
 * driver. `unverified` means the provider has not said, and must never be
 * shown to the driver as a refusal on the facts.
 */
export const CASH_ACCESS_REASON_KIND_V1: Readonly<Record<
    CashAccessRefusalReasonV1,
    'identity' | 'decided' | 'stated' | 'unverified' | 'entitlement'
>> = {
    identity_not_proven: 'identity',
    identity_needs_review: 'identity',
    identity_busy: 'identity',
    authority_refused: 'identity',
    manual_deny: 'decided',
    not_self_employed: 'stated',
    outside_first_calendar_month: 'stated',
    self_employment_unknown: 'unverified',
    hire_date_unknown: 'unverified',
    standard_facts_unavailable: 'unverified',
    no_entitlement: 'entitlement',
    referral_access_revoked: 'entitlement',
}

export type CashReferralOfferV1 = 'offer' | 'no_offer' | 'owner_decision_required'

/** Why a manual record present in the input took no part in the decision. */
export type CashAccessIgnoredRecordV1 =
    | 'manual_record_unsigned'
    | 'manual_record_missing_capability'
    | 'manual_record_not_yet_effective'

export type CashAccessDecisionV1 =
    | {
        access: 'granted'
        at: Date
        windows: readonly CashAccessWindowV1[]
        ignored: readonly CashAccessIgnoredRecordV1[]
    }
    | {
        access: 'refused'
        at: Date
        /** The first reason is the one the driver is told; the rest are also true. */
        reasons: readonly CashAccessRefusalReasonV1[]
        referralOffer: CashReferralOfferV1
        ignored: readonly CashAccessIgnoredRecordV1[]
    }
    | {
        /** Not claimable: an Owner decision is missing, not a rule. */
        access: 'owner_decision_required'
        at: Date
        scenario: 'P6_manual_deny_vs_standard_programme'
        referralOffer: CashReferralOfferV1
        ignored: readonly CashAccessIgnoredRecordV1[]
    }

type StandardOutcomeV1 =
    | { window: CashAccessWindowV1; refusal: null }
    | { window: null; refusal: CashAccessRefusalReasonV1 }

/**
 * The standard programme through its own decision functions, so its answer
 * here cannot drift from the live one: the same refusal order, the same first
 * month, and the same last instant (the month's end plus the grace).
 */
function standardOutcomeV1(facts: CompensationEligibilityFactsV1 | null, at: Date): StandardOutcomeV1 {
    if (facts === null) return { window: null, refusal: 'standard_facts_unavailable' }
    const decision = compensationPilotEligibilityV1(facts, at)
    if (!decision.eligible) return { window: null, refusal: decision.reason }
    const first = compensationPilotFirstMonthV1(facts)
    const basis = compensationPilotAdmissionBasisV1(facts)
    // Both follow from an eligible decision; they are read again only for the
    // window and the basis.
    if (!first.ok || basis === null) return { window: null, refusal: 'standard_facts_unavailable' }
    return {
        window: { basis, ordersFrom: first.windowStartsAt, ordersUntil: first.windowEndsAt },
        refusal: null,
    }
}

function referralWindowV1(
    referral: CashReferralEntitlementV1 | null,
    at: Date,
): { window: CashAccessWindowV1 | null; revoked: boolean } {
    if (referral === null) return { window: null, revoked: false }
    if (referral.revokedAt !== null && referral.revokedAt.getTime() <= at.getTime()) {
        return { window: null, revoked: true }
    }
    if (referral.confirmedAt.getTime() > at.getTime()) return { window: null, revoked: false }
    return {
        window: { basis: 'referral', ordersFrom: referral.confirmedAt, ordersUntil: referral.revokedAt },
        revoked: false,
    }
}

/** The manual record, only when a signed staff session with the capability made it. */
function authorisedManualV1(
    manual: CashManualAccessV1 | null,
    at: Date,
    ignored: CashAccessIgnoredRecordV1[],
): CashManualAccessV1 | null {
    if (manual === null) return null
    const actor = manual.actor
    if (actor.kind !== 'signed_staff_session' || actor.principalId.trim() === '') {
        ignored.push('manual_record_unsigned')
        return null
    }
    if (!actor.capabilities.includes(CASH_ACCESS_MANAGE_CAPABILITY_V1)) {
        ignored.push('manual_record_missing_capability')
        return null
    }
    if (manual.decidedAt.getTime() > at.getTime()) {
        ignored.push('manual_record_not_yet_effective')
        return null
    }
    return manual
}

function ownerChoiceV1(choice: boolean | undefined): CashReferralOfferV1 {
    if (choice === undefined) return 'owner_decision_required'
    return choice ? 'offer' : 'no_offer'
}

/**
 * Decides Cash access for one person at one instant.
 *
 * Deterministic: the result depends on the input alone, and the input is
 * never modified.
 */
export function decideCashAccessV1(input: CashAccessInputV1): CashAccessDecisionV1 {
    const at = input.at
    if (!input.identity.proven) {
        // A grant does not reach past identity: nothing below is even read.
        return { access: 'refused', at, reasons: [input.identity.refusal], referralOffer: 'no_offer', ignored: [] }
    }

    const ignored: CashAccessIgnoredRecordV1[] = []
    const manual = authorisedManualV1(input.manual, at, ignored)
    const standard = standardOutcomeV1(input.standardFacts, at)

    if (manual !== null && manual.decision === 'deny') {
        const referralOffer = ownerChoiceV1(input.ownerPolicy.referralOfferAfterManualDeny)
        if (standard.window === null) {
            return { access: 'refused', at, reasons: ['manual_deny', standard.refusal], referralOffer, ignored }
        }
        const closesStandard = input.ownerPolicy.manualDenyClosesStandardProgramme
        if (closesStandard === undefined) {
            return {
                access: 'owner_decision_required',
                at,
                scenario: 'P6_manual_deny_vs_standard_programme',
                referralOffer,
                ignored,
            }
        }
        if (closesStandard) return { access: 'refused', at, reasons: ['manual_deny'], referralOffer, ignored }
        return { access: 'granted', at, windows: [standard.window], ignored }
    }

    const referral = referralWindowV1(input.referral, at)
    const windows: CashAccessWindowV1[] = []
    if (manual !== null) windows.push({ basis: 'manual_grant', ordersFrom: manual.decidedAt, ordersUntil: null })
    if (referral.window !== null) windows.push(referral.window)
    if (standard.window !== null) windows.push(standard.window)
    if (windows.length > 0) return { access: 'granted', at, windows, ignored }

    return {
        access: 'refused',
        at,
        reasons: [standard.refusal ?? 'standard_facts_unavailable', referral.revoked ? 'referral_access_revoked' : 'no_entitlement'],
        referralOffer: 'offer',
        ignored,
    }
}

function windowCoversV1(window: CashAccessWindowV1, instant: Date): boolean {
    return instant.getTime() >= window.ordersFrom.getTime()
        && (window.ordersUntil === null || instant.getTime() < window.ordersUntil.getTime())
}

/**
 * Whether one order may be claimed under a decision, at the decision's own
 * instant: some window covers its completion and its own submission window
 * (the order month's end plus the grace) is still open.
 */
export function cashAccessOrderClaimableV1(decision: CashAccessDecisionV1, order: { endedAt: Date }): boolean {
    if (decision.access !== 'granted') return false
    if (!cashOrderSubmissionOpenV1(order, decision.at)) return false
    return decision.windows.some((window) => windowCoversV1(window, order.endedAt))
}

/**
 * Whether the driver may pick a business day to search: a day that has begun,
 * whose orders are still within their submission window, and that some window
 * reaches into. For the standard basis alone this is exactly the first-month
 * day rule the on-demand picker applies today.
 */
export function cashAccessDayAllowedV1(decision: CashAccessDecisionV1, dayKey: string): boolean {
    if (decision.access !== 'granted') return false
    let dayStart: Date
    let dayEnd: Date
    try {
        const day = parseCompensationBusinessDayKeyV1(dayKey)
        dayStart = compensationDayStartInstantV1(day)
        dayEnd = compensationDayEndInstantV1(day)
    } catch {
        return false
    }
    if (dayStart.getTime() > decision.at.getTime()) return false
    if (!cashOrderSubmissionOpenV1({ endedAt: dayStart }, decision.at)) return false
    return decision.windows.some((window) => window.ordersFrom.getTime() < dayEnd.getTime()
        && (window.ordersUntil === null || dayStart.getTime() < window.ordersUntil.getTime()))
}

export type CashAccessOrderCatalogueV1<T extends StoredCashOrderV1 = StoredCashOrderV1> =
    | {
        eligible: true
        /** The budget period of every month whose orders may be claimed now, oldest first. */
        budgetPeriodKeys: readonly string[]
        orders: readonly T[]
    }
    | {
        eligible: false
        reason: CashAccessRefusalReasonV1 | 'owner_decision_required'
        orders: readonly []
    }

/**
 * The months a decision lets the driver claim from right now: begun, still
 * open for submissions, and reached by some window. At most the current
 * month and, in the grace after a month's end, the one before it.
 */
function claimableMonthKeysV1(decision: Extract<CashAccessDecisionV1, { access: 'granted' }>): string[] {
    const current = compensationCalendarMonthV1(decision.at)
    const previous = compensationCalendarMonthV1(new Date(compensationMonthStartInstantV1(current).getTime() - 1))
    return [previous, current]
        .filter((month) => {
            const monthStart = compensationMonthStartInstantV1(month)
            const monthEnd = compensationMonthEndInstantV1(month).getTime()
            // Every order of a month shares the month's own deadline.
            return cashOrderSubmissionOpenV1({ endedAt: monthStart }, decision.at)
                && decision.windows.some((window) => window.ordersFrom.getTime() < monthEnd
                    && (window.ordersUntil === null || monthStart.getTime() < window.ordersUntil.getTime()))
        })
        .map((month) => compensationPeriodKeyV1(month))
}

/**
 * The orders a driver may claim against right now, under every basis they
 * hold, newest first.
 *
 * For the standard basis alone this is exactly the first-month catalogue the
 * section lists today, and its one budget period is the first month. A
 * referral or manual window carries the same rule into every later month: an
 * order is listed while its own submission window is open, and its claim
 * reserves against its own month's budget in C1.
 */
export function cashAccessOrderCatalogueV1<T extends StoredCashOrderV1>(
    decision: CashAccessDecisionV1,
    storedOrders: readonly T[],
): CashAccessOrderCatalogueV1<T> {
    if (decision.access === 'refused') return { eligible: false, reason: decision.reasons[0], orders: [] }
    if (decision.access === 'owner_decision_required') return { eligible: false, reason: 'owner_decision_required', orders: [] }
    const orders = storedOrders
        .filter((order) => cashAccessOrderClaimableV1(decision, order))
        .slice()
        .sort((left, right) => right.endedAt.getTime() - left.endedAt.getTime())
    return { eligible: true, budgetPeriodKeys: claimableMonthKeysV1(decision), orders }
}
