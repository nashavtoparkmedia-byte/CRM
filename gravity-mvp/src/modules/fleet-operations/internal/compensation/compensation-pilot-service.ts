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

export interface PilotDriverIdentityV1 {
    telegramUserId: string
    /** Canonical contact proven for this Telegram account, or null. */
    canonicalContactId: string | null
    externalParkId: string | null
    externalDriverProfileId: string | null
    facts: CompensationEligibilityFactsV1
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
    canonicalContactId: string
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
    /** Resolves the Telegram account to a driver and the facts eligibility needs. */
    findDriverIdentity(telegramUserId: string): Promise<PilotDriverIdentityV1 | null>
    findCashOrders(input: { externalParkId: string; externalDriverProfileId: string }): Promise<StoredCashOrderV1[]>
    findBudgetPeriod(periodKey: string): Promise<{
        limitKopecks: number; reservedKopecks: number; settledKopecks: number
    } | null>
    findClaimedOrderIds(canonicalContactId: string): Promise<string[]>
    findDriverApplications(canonicalContactId: string): Promise<PilotApplicationSummaryV1[]>
    findManagerApplications(): Promise<ManagerApplicationRowV1[]>
    findManagerApplication(applicationId: string): Promise<ManagerApplicationRowV1 | null>
    /** C1 submit, plus the pilot evidence, as one unit. */
    submitApplication(input: {
        canonicalContactId: string
        order: StoredCashOrderV1
        claimedRubles: number
        telegramUserId: string
        attachmentFileId: string
        attachmentKind: string
        idempotencyKey: string
        submittedAt: Date
    }): Promise<{ applicationId: string; amountKopecks: number; status: 'created' | 'replayed' }>
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

export const PILOT_VIEW_REFUSALS_V1 = ['identity_not_proven', 'driver_not_in_park'] as const
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

/**
 * What the compensation section shows.
 *
 * An unproven identity yields no list at all rather than an empty one: the
 * driver is told their account is not linked, which is a different problem
 * from having no eligible orders.
 */
export async function compensationSectionViewV1(
    telegramUserId: string,
    port: CompensationPilotPortV1,
    now: Date,
): Promise<CompensationSectionViewV1> {
    const identity = await port.findDriverIdentity(telegramUserId)
    if (!identity || !identity.canonicalContactId) {
        return { available: false, reason: 'identity_not_proven', applications: [] }
    }

    const applications = await port.findDriverApplications(identity.canonicalContactId)

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

export type PilotSubmitOutcomeV1 =
    | { submitted: true; applicationId: string; amountKopecks: number; status: 'created' | 'replayed' }
    | { submitted: false; refusal: PilotSubmissionRefusalV1 | PilotViewRefusalV1 | string }

/**
 * Submits one claim.
 *
 * The catalogue is rebuilt here rather than trusted from the conversation, so
 * an order that stopped being eligible while the driver was typing cannot be
 * claimed, and neither can an id the bot never offered.
 */
export async function submitPilotApplicationV1(
    input: {
        telegramUserId: string
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
    const view = await compensationSectionViewV1(input.telegramUserId, port, now)
    if (!view.available) return { submitted: false, refusal: view.reason }

    const identity = await port.findDriverIdentity(input.telegramUserId)
    if (!identity?.canonicalContactId) return { submitted: false, refusal: 'identity_not_proven' }

    const gate = decidePilotSubmissionV1({
        externalOrderId: input.externalOrderId,
        claimedRubles: input.claimedRubles,
        supportConfirmed: input.supportConfirmed,
        attachmentFileId: input.attachmentFileId,
        attachmentKind: input.attachmentKind,
    }, {
        catalogue: view.orders,
        alreadyClaimedOrderIds: await port.findClaimedOrderIds(identity.canonicalContactId),
        remainingBudgetKopecks: view.remainingBudgetKopecks,
    })
    if (!gate.accepted) return { submitted: false, refusal: gate.refusal }

    const result = await port.submitApplication({
        canonicalContactId: identity.canonicalContactId,
        order: gate.order,
        claimedRubles: gate.claimedRubles,
        telegramUserId: input.telegramUserId,
        attachmentFileId: gate.attachmentFileId,
        attachmentKind: gate.attachmentKind,
        idempotencyKey: input.idempotencyKey,
        submittedAt: now,
    })
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
