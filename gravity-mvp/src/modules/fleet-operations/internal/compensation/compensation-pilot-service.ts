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
 */

import {
    cashOrderCatalogueV1,
    type StoredCashOrderV1,
} from './compensation-cash-order-ingestion'
import type { CompensationEligibilityFactsV1 } from './compensation-eligibility'
import {
    decidePilotSubmissionV1,
    pilotDriverStatusV1,
    remainingBudgetKopecksV1,
    routeManagerActionV1,
    type ManagerActionV1,
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
 */
export interface PilotTelegramPersonProofV1 {
    telegramUserId: string
    driverId: string
    contactId: string
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

export interface ManagerApplicationRowV1 extends PilotApplicationSummaryV1 {
    /** Every contact bound to the application's monetary person. */
    boundContactIds: string[]
    externalParkId: string
    telegramUserId: string | null
    attachmentFileId: string | null
    attachmentKind: string | null
    supportContactedAt: Date | null
    hasLiveAuthorization: boolean
    hasOpenReconciliation: boolean
    /** Present only while a payout is in flight; needed to finalize it. */
    payoutAuthorizationId: string | null
    authorizationFence: string | null
}

export interface CompensationPilotPortV1 {
    /** Contacts' confirmation that the Contact's person is this Driver. */
    confirmMainDriver(contactId: string, driverId: string): Promise<PilotMainDriverConfirmationV1>
    resolveContactLineage(contactId: string): Promise<PilotContactLineageReadV1>
    /** The facts eligibility needs, read from the proven Driver row only. */
    findDriverFacts(driverId: string): Promise<PilotDriverFactsV1 | null>
    findCashOrders(input: { externalParkId: string; externalDriverProfileId: string }): Promise<StoredCashOrderV1[]>
    findBudgetPeriod(periodKey: string): Promise<{
        limitKopecks: number; reservedKopecks: number; settledKopecks: number
    } | null>
    findClaimedOrderIds(lineage: readonly string[]): Promise<string[]>
    findDriverApplications(lineage: readonly string[]): Promise<PilotApplicationSummaryV1[]>
    findManagerApplications(): Promise<ManagerApplicationRowV1[]>
    findManagerApplication(applicationId: string): Promise<ManagerApplicationRowV1 | null>
    /** C1 submit, plus the pilot evidence, as one unit. */
    submitApplication(input: {
        canonicalContactId: string
        lineage: readonly string[]
        order: StoredCashOrderV1
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
    startPayout(input: { applicationId: string; principalId: string; operatorLabel: string | null }): Promise<void>
    rejectApplication(input: {
        applicationId: string; reason: string; rejectionKey: string
        principalId: string; operatorLabel: string | null
    }): Promise<void>
    finalizePayout(input: {
        payoutAuthorizationId: string; authorizationFence: string
        principalId: string; operatorLabel: string | null
    }): Promise<void>
    resolveReconciliation(input: {
        applicationId: string; principalId: string; operatorLabel: string | null
    }): Promise<void>
}

export const PILOT_VIEW_REFUSALS_V1 = [
    'identity_not_proven',
    'identity_needs_review',
    'identity_busy',
    'driver_not_in_park',
] as const
export type PilotViewRefusalV1 = typeof PILOT_VIEW_REFUSALS_V1[number]

export type CompensationSectionViewV1 =
    | {
        available: true
        firstMonthKey: string
        remainingBudgetKopecks: number
        orders: readonly StoredCashOrderV1[]
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

async function sectionForIdentityV1(
    identity: PilotDriverIdentityV1,
    port: CompensationPilotPortV1,
    now: Date,
): Promise<CompensationSectionViewV1> {
    const applications = await port.findDriverApplications(identity.lineage)

    if (!identity.externalParkId || !identity.externalDriverProfileId) {
        return { available: false, reason: 'driver_not_in_park', applications }
    }

    const stored = await port.findCashOrders({
        externalParkId: identity.externalParkId,
        externalDriverProfileId: identity.externalDriverProfileId,
    })
    const catalogue = cashOrderCatalogueV1(identity.facts, stored, now)
    if (!catalogue.eligible) {
        return { available: false, reason: catalogue.reason, applications }
    }

    const period = await port.findBudgetPeriod(catalogue.firstMonthKey)
    const remainingBudgetKopecks = period ? remainingBudgetKopecksV1(period) : 0

    return {
        available: true,
        firstMonthKey: catalogue.firstMonthKey,
        remainingBudgetKopecks,
        orders: catalogue.orders,
        applications,
    }
}

/**
 * What the compensation section shows.
 *
 * An unproven identity yields no list at all rather than an empty one: the
 * driver is told their account is not linked, which is a different problem
 * from having no eligible orders.
 */
export async function compensationSectionViewV1(
    proof: PilotTelegramPersonProofV1,
    port: CompensationPilotPortV1,
    now: Date,
): Promise<CompensationSectionViewV1> {
    const resolved = await resolvePilotIdentityV1(proof, port)
    if (!resolved.proven) return { available: false, reason: resolved.refusal, applications: [] }
    // The public section is a plain view built here, never a value handed back
    // from a helper that holds the port.
    const view = await sectionForIdentityV1(resolved.identity, port, now)
    return view.available
        ? {
            available: true,
            firstMonthKey: view.firstMonthKey,
            remainingBudgetKopecks: view.remainingBudgetKopecks,
            orders: view.orders,
            applications: view.applications,
        }
        : { available: false, reason: view.reason, applications: view.applications }
}

export type PilotSubmitOutcomeV1 =
    | { submitted: true; applicationId: string; amountKopecks: number; status: 'created' | 'replayed' }
    | { submitted: false; refusal: PilotSubmissionRefusalV1 | PilotViewRefusalV1 | string }

/**
 * Submits one claim.
 *
 * The identity is resolved once, so the claimed-order check and the C1 submit
 * see the same person. The catalogue is rebuilt here rather than trusted from
 * the conversation, so an order that stopped being eligible while the driver
 * was typing cannot be claimed, and neither can an id the bot never offered.
 */
export async function submitPilotApplicationV1(
    input: PilotTelegramPersonProofV1 & {
        externalOrderId: string
        claimedRubles: number
        supportConfirmed: boolean
        attachmentFileId: string | null
        attachmentKind: string | null
        idempotencyKey: string
    },
    port: CompensationPilotPortV1,
    now: Date,
): Promise<PilotSubmitOutcomeV1> {
    const resolved = await resolvePilotIdentityV1(input, port)
    if (!resolved.proven) return { submitted: false, refusal: resolved.refusal }
    const identity = resolved.identity

    const view = await sectionForIdentityV1(identity, port, now)
    if (!view.available) return { submitted: false, refusal: view.reason }

    const gate = decidePilotSubmissionV1({
        externalOrderId: input.externalOrderId,
        claimedRubles: input.claimedRubles,
        supportConfirmed: input.supportConfirmed,
        attachmentFileId: input.attachmentFileId,
        attachmentKind: input.attachmentKind,
    }, {
        catalogue: view.orders,
        alreadyClaimedOrderIds: await port.findClaimedOrderIds(identity.lineage),
        remainingBudgetKopecks: view.remainingBudgetKopecks,
    })
    if (!gate.accepted) return { submitted: false, refusal: gate.refusal }

    const result = await port.submitApplication({
        canonicalContactId: identity.canonicalContactId,
        lineage: identity.lineage,
        order: gate.order,
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

export type ManagerActionOutcomeV1 =
    | { performed: true; operation: string }
    | { performed: false; refusal: string }

/**
 * Performs a manager action by routing it to the C1 operation that does it.
 *
 * The routing decision and the call are kept together so a screen cannot
 * finalize a payout that was never authorized by calling the wrong one.
 */
export async function performManagerActionV1(
    input: {
        applicationId: string
        action: ManagerActionV1
        principalId: string
        operatorLabel: string | null
        /** Required for reject; ignored otherwise. */
        reason?: string
        rejectionKey?: string
    },
    port: CompensationPilotPortV1,
): Promise<ManagerActionOutcomeV1> {
    const row = await port.findManagerApplication(input.applicationId)
    if (!row) return { performed: false, refusal: 'application_not_found' }

    const route = routeManagerActionV1(input.action, {
        status: row.status === 'paid' ? 'PAID' : row.status === 'rejected' ? 'REJECTED' : 'PENDING',
        hasLiveAuthorization: row.hasLiveAuthorization,
        hasOpenReconciliation: row.hasOpenReconciliation,
    })
    if ('refusal' in route) return { performed: false, refusal: route.refusal }

    switch (route.operation) {
        case 'start_payout':
            await port.startPayout({
                applicationId: row.applicationId,
                principalId: input.principalId,
                operatorLabel: input.operatorLabel,
            })
            return { performed: true, operation: 'start_payout' }

        case 'reject_application': {
            const reason = (input.reason ?? '').trim()
            if (reason === '') return { performed: false, refusal: 'reject_requires_reason' }
            await port.rejectApplication({
                applicationId: row.applicationId,
                reason,
                rejectionKey: input.rejectionKey ?? row.applicationId,
                principalId: input.principalId,
                operatorLabel: input.operatorLabel,
            })
            return { performed: true, operation: 'reject_application' }
        }

        case 'finalize_payout': {
            // Routing already established an authorization is live; without its
            // fence C1 would refuse, so a missing one is a bug, not a refusal.
            if (!row.payoutAuthorizationId || !row.authorizationFence) {
                return { performed: false, refusal: 'authorization_evidence_missing' }
            }
            await port.finalizePayout({
                payoutAuthorizationId: row.payoutAuthorizationId,
                authorizationFence: row.authorizationFence,
                principalId: input.principalId,
                operatorLabel: input.operatorLabel,
            })
            return { performed: true, operation: 'finalize_payout' }
        }

        case 'resolve_reconciliation':
            await port.resolveReconciliation({
                applicationId: row.applicationId,
                principalId: input.principalId,
                operatorLabel: input.operatorLabel,
            })
            return { performed: true, operation: 'resolve_reconciliation' }
    }
}

export { pilotDriverStatusV1 }
