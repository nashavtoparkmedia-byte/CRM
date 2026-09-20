/**
 * The manager seam: the list, one application, the month's budget and the
 * monetary actions a manager may take.
 *
 * Every decision comes from compensation-manager-view; every monetary change is
 * a C1 entry point called through the port, unchanged. Nothing here computes an
 * amount, a status or a remaining budget of its own.
 *
 * Concurrency is C1's. Two managers acting at once are serialised by its row
 * locks: approve and reject are revalidated against the locked application, and
 * every payout operation presents the authorization fence this service read,
 * which C1 compares under the same lock. A refusal therefore means the state
 * moved, and the answer carries the state it moved to rather than a stale echo
 * of what the screen believed.
 */

import { createHash } from 'node:crypto'

import {
    managerAllowedActionsV1,
    managerApplicationStateV1,
    managerAuthorizationAgeV1,
    managerBudgetViewV1,
    managerResultForCompensationErrorV1,
    normalizeManagerFilterV1,
    routeManagerActionV1,
    encodeManagerCursorV1,
    compensationBusinessDisplayV1,
    type ManagerActionV1,
    type ManagerApplicationStateV1,
    type ManagerAuthorizationAgeV1,
    type ManagerAuthorizationStateV1,
    type ManagerBudgetFactsV1,
    type ManagerBudgetViewV1,
    type ManagerEvidenceStateV1,
    type ManagerListFilterInputV1,
    type ManagerListFilterV1,
    type ManagerResultCodeV1,
} from './compensation-manager-view'
import { COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS } from './compensation-policy'

export interface ManagerPrincipalV1 {
    principalId: string
    operatorLabel: string | null
}

/** The stored facts of one application, as the manager adapter reads them. */
export interface ManagerApplicationFactsV1 {
    applicationId: string
    status: string
    version: number
    periodKey: string
    submittedAt: Date
    paidAt: Date | null
    rejectedAt: Date | null
    rejectionReason: string | null
    requestedKopecks: number
    payableKopecks: number
    orderAmountKopecks: number
    provider: string
    externalParkId: string
    parkName: string | null
    externalOrderId: string
    shortOrderIdDisplay: string | null
    orderEndedAt: Date
    orderRawPrice: string
    orderVerifiedAt: Date
    driverName: string | null
    driverPhone: string | null
    externalDriverProfileId: string | null
    boundContactIds: string[]
    telegramUserId: string | null
    attachmentKind: string | null
    hasAttachment: boolean
    supportContactedAt: Date | null
    authorization: {
        id: string
        state: ManagerAuthorizationStateV1
        authorizationFence: string
        intendedBusinessDay: string
        openedAt: Date
        expiresAt: Date
        openedByLabel: string | null
    } | null
    reconciliation: { id: string; state: string; reason: string; openedAt: Date } | null
    settlement: { id: string; amountKopecks: number; businessDay: string; settledAt: Date; settledByLabel: string | null } | null
    /** The catalogue row for this order right now, if ingestion still holds one. */
    catalogue: { amountKopecks: number; observedAt: Date; providerBookedAt: Date | null } | null
}

export interface ManagerHistoryEntryV1 {
    occurredAt: Date
    action: string
    actorLabel: string
    previousState: string | null
    nextState: string | null
    amountKopecks: number | null
    reason: string | null
}

export interface ManagerApplicationDetailFactsV1 extends ManagerApplicationFactsV1 {
    history: ManagerHistoryEntryV1[]
}

export interface CompensationManagerActionOutcomeV1 {
    ok: boolean
    /** The monetary-core code when the operation refused. */
    code: string | null
    /** True when C1 reported the change had already happened. */
    replayed: boolean
}

export interface CompensationManagerPortV1 {
    findApplications(filter: ManagerListFilterV1): Promise<{ rows: ManagerApplicationFactsV1[]; hasMore: boolean }>
    findApplication(applicationId: string): Promise<ManagerApplicationDetailFactsV1 | null>
    findBudget(periodKey: string): Promise<ManagerBudgetFactsV1 | null>
    /** Server-only: what the evidence transport needs, never a browser DTO. */
    findEvidenceSource(applicationId: string): Promise<{ fileId: string; kind: string | null } | null>
    startPayout(input: { applicationId: string; principal: ManagerPrincipalV1 }): Promise<CompensationManagerActionOutcomeV1>
    rejectApplication(input: {
        applicationId: string; reason: string; rejectionKey: string; principal: ManagerPrincipalV1
    }): Promise<CompensationManagerActionOutcomeV1>
    finalizePayout(input: {
        payoutAuthorizationId: string; authorizationFence: string; principal: ManagerPrincipalV1
    }): Promise<CompensationManagerActionOutcomeV1>
    releasePayout(input: {
        payoutAuthorizationId: string
        authorizationFence: string
        kind: 'cancel_preparation' | 'declare_outcome_unknown'
        reason: string
        principal: ManagerPrincipalV1
    }): Promise<CompensationManagerActionOutcomeV1>
    resolveReconciliation(input: {
        reconciliationTaskId: string
        resolution: 'paid' | 'not_paid'
        resolutionEvidence: string
        principal: ManagerPrincipalV1
    }): Promise<CompensationManagerActionOutcomeV1>
}

export interface ManagerOrderViewV1 {
    externalOrderId: string
    shortOrderIdDisplay: string | null
    endedAt: Date
    dayKey: string
    localDate: string
    localTime: string
}

export interface ManagerApplicationRowV1 {
    applicationId: string
    state: ManagerApplicationStateV1
    submittedAt: Date
    periodKey: string
    externalParkId: string
    parkName: string | null
    driverName: string | null
    order: ManagerOrderViewV1
    requestedKopecks: number
    orderAmountKopecks: number
    payableKopecks: number
    evidence: ManagerEvidenceStateV1
}

export interface ManagerApplicationListV1 {
    rows: ManagerApplicationRowV1[]
    nextCursor: string | null
    filter: { periodKey: string | null; state: ManagerApplicationStateV1 | null; externalParkId: string | null; limit: number }
}

export interface ManagerApplicationDetailV1 extends ManagerApplicationRowV1 {
    status: string
    driverPhone: string | null
    externalDriverProfileId: string | null
    boundContactIds: string[]
    telegramUserId: string | null
    attachmentKind: string | null
    supportContactedAt: Date | null
    rejectionReason: string | null
    paidAt: Date | null
    rejectedAt: Date | null
    /** What C1 froze when the claim was verified. */
    snapshot: { rawPrice: string; amountKopecks: number; verifiedAt: Date; endedAt: Date }
    /** What cash-order ingestion holds for the same order right now. */
    catalogue: { present: boolean; amountKopecks: number | null; observedAt: Date | null; providerBookedAt: Date | null }
    authorization: {
        state: ManagerAuthorizationStateV1
        intendedBusinessDay: string
        openedAt: Date
        openedByLabel: string | null
        age: ManagerAuthorizationAgeV1
    } | null
    reconciliation: { state: string; reason: string; openedAt: Date } | null
    settlement: { amountKopecks: number; businessDay: string; settledAt: Date; settledByLabel: string | null } | null
    history: ManagerHistoryEntryV1[]
    allowedActions: ManagerActionV1[]
}

function evidenceState(facts: ManagerApplicationFactsV1): ManagerEvidenceStateV1 {
    return facts.hasAttachment ? 'present' : 'missing'
}

function orderView(facts: ManagerApplicationFactsV1): ManagerOrderViewV1 {
    const display = compensationBusinessDisplayV1(facts.orderEndedAt)
    return {
        externalOrderId: facts.externalOrderId,
        shortOrderIdDisplay: facts.shortOrderIdDisplay,
        endedAt: facts.orderEndedAt,
        dayKey: display.dayKey,
        localDate: display.localDate,
        localTime: display.localTime,
    }
}

function rowView(facts: ManagerApplicationFactsV1): ManagerApplicationRowV1 {
    return {
        applicationId: facts.applicationId,
        state: managerApplicationStateV1({
            status: facts.status,
            authorizationState: facts.authorization === null ? null : facts.authorization.state,
            hasOpenReconciliation: facts.reconciliation !== null && facts.reconciliation.state === 'open',
        }),
        submittedAt: facts.submittedAt,
        periodKey: facts.periodKey,
        externalParkId: facts.externalParkId,
        parkName: facts.parkName,
        driverName: facts.driverName,
        order: orderView(facts),
        requestedKopecks: facts.requestedKopecks,
        orderAmountKopecks: facts.orderAmountKopecks,
        payableKopecks: facts.payableKopecks,
        evidence: evidenceState(facts),
    }
}

function stateFacts(facts: ManagerApplicationFactsV1) {
    return {
        status: facts.status,
        authorizationState: facts.authorization === null ? null : facts.authorization.state,
        hasOpenReconciliation: facts.reconciliation !== null && facts.reconciliation.state === 'open',
        evidence: evidenceState(facts),
    }
}

/**
 * One page of applications, newest first. The cursor is the sort key, so a page
 * break can neither skip nor repeat a row while managers act on the list.
 */
export async function listManagerApplicationsV1(
    input: ManagerListFilterInputV1,
    port: CompensationManagerPortV1,
): Promise<ManagerApplicationListV1> {
    const filter = normalizeManagerFilterV1(input)
    const page = await port.findApplications(filter)
    const rows = page.rows.map(rowView)
    const last = page.rows[page.rows.length - 1]
    return {
        rows,
        nextCursor: page.hasMore && last
            ? encodeManagerCursorV1({ submittedAt: last.submittedAt, applicationId: last.applicationId })
            : null,
        filter: {
            periodKey: filter.periodKey,
            state: filter.state,
            externalParkId: filter.externalParkId,
            limit: filter.limit,
        },
    }
}

/** One application, with the history C1 recorded and the actions it is open to. */
export async function readManagerApplicationV1(
    applicationId: string,
    port: CompensationManagerPortV1,
    now: Date,
): Promise<ManagerApplicationDetailV1 | null> {
    const facts = await port.findApplication(applicationId)
    if (facts === null) return null
    const row = rowView(facts)
    return {
        ...row,
        status: facts.status,
        driverPhone: facts.driverPhone,
        externalDriverProfileId: facts.externalDriverProfileId,
        boundContactIds: facts.boundContactIds,
        telegramUserId: facts.telegramUserId,
        attachmentKind: facts.attachmentKind,
        supportContactedAt: facts.supportContactedAt,
        rejectionReason: facts.rejectionReason,
        paidAt: facts.paidAt,
        rejectedAt: facts.rejectedAt,
        snapshot: {
            rawPrice: facts.orderRawPrice,
            amountKopecks: facts.orderAmountKopecks,
            verifiedAt: facts.orderVerifiedAt,
            endedAt: facts.orderEndedAt,
        },
        catalogue: {
            present: facts.catalogue !== null,
            amountKopecks: facts.catalogue === null ? null : facts.catalogue.amountKopecks,
            observedAt: facts.catalogue === null ? null : facts.catalogue.observedAt,
            providerBookedAt: facts.catalogue === null ? null : facts.catalogue.providerBookedAt,
        },
        authorization: facts.authorization === null ? null : {
            state: facts.authorization.state,
            intendedBusinessDay: facts.authorization.intendedBusinessDay,
            openedAt: facts.authorization.openedAt,
            openedByLabel: facts.authorization.openedByLabel,
            age: managerAuthorizationAgeV1(facts.authorization, now, COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS),
        },
        reconciliation: facts.reconciliation === null ? null : {
            state: facts.reconciliation.state,
            reason: facts.reconciliation.reason,
            openedAt: facts.reconciliation.openedAt,
        },
        settlement: facts.settlement === null ? null : {
            amountKopecks: facts.settlement.amountKopecks,
            businessDay: facts.settlement.businessDay,
            settledAt: facts.settlement.settledAt,
            settledByLabel: facts.settlement.settledByLabel,
        },
        history: facts.history,
        allowedActions: managerAllowedActionsV1(stateFacts(facts)),
    }
}

export async function readManagerBudgetV1(
    periodKey: string,
    port: CompensationManagerPortV1,
): Promise<ManagerBudgetViewV1> {
    return managerBudgetViewV1(periodKey, await port.findBudget(periodKey))
}

export interface ManagerActionResultV1 {
    code: ManagerResultCodeV1
    /** The state the application is in after the attempt, read back from storage. */
    state: ManagerApplicationStateV1 | null
    applicationId: string
}

/**
 * A rejection key that is the same for every retry of one rejection and
 * different for the next one.
 *
 * C1 replays a repeated reject only when the key matches, so a lost response
 * must retry with the same key. The application version moves on every
 * settled transition, which is what makes a later, genuinely new rejection a
 * different key.
 */
export function managerRejectionKeyV1(applicationId: string, version: number): string {
    const digest = createHash('sha256').update(`${applicationId}|${version}`).digest('hex')
    return `mgr_reject_${digest.slice(0, 40)}`
}

/**
 * Performs one manager action.
 *
 * The application is read first so the action can be routed and refused in the
 * manager's own words, but that read is not a concurrency check: C1 revalidates
 * everything under its locks, and a fenced payout operation is compared against
 * the authorization row itself. Whatever happens, the state is read back and
 * returned, so a screen never keeps a belief this function did not confirm.
 */
export async function performManagerActionV1(
    input: {
        applicationId: string
        action: ManagerActionV1
        reason?: string | null
        principal: ManagerPrincipalV1
        /**
         * Whether the caller fetched the stored screenshot successfully just
         * now. Only approving reads it, and absence means no: the evidence
         * transport belongs to the Telegram channel, which this context may
         * not reach, so the composition root proves it and says so here.
         */
        evidenceProven?: boolean
    },
    port: CompensationManagerPortV1,
): Promise<ManagerActionResultV1> {
    const facts = await port.findApplication(input.applicationId)
    if (facts === null) {
        return { code: 'application_not_found', state: null, applicationId: input.applicationId }
    }

    const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
    const before = stateFacts(facts)
    const settled = async (code: ManagerResultCodeV1): Promise<ManagerActionResultV1> => {
        const after = await port.findApplication(input.applicationId)
        return {
            code,
            state: after === null ? null : managerApplicationStateV1(stateFacts(after)),
            applicationId: input.applicationId,
        }
    }

    if (input.action === 'reject' && reason === '') {
        return { code: 'reject_requires_reason', state: managerApplicationStateV1(before), applicationId: input.applicationId }
    }

    const route = routeManagerActionV1(input.action, before)
    if ('refusal' in route) return settled(route.refusal)

    // Approving is the one action the evidence gates, and metadata alone does
    // not prove the manager can see the screenshot: the composition root
    // fetches it first and says whether that worked.
    if (input.action === 'approve' && input.evidenceProven !== true) {
        return settled('evidence_unavailable')
    }

    let outcome: CompensationManagerActionOutcomeV1
    switch (route.operation) {
        case 'start_payout':
            outcome = await port.startPayout({ applicationId: facts.applicationId, principal: input.principal })
            break
        case 'reject_application':
            outcome = await port.rejectApplication({
                applicationId: facts.applicationId,
                reason,
                rejectionKey: managerRejectionKeyV1(facts.applicationId, facts.version),
                principal: input.principal,
            })
            break
        case 'finalize_payout':
            outcome = await port.finalizePayout({
                payoutAuthorizationId: facts.authorization!.id,
                authorizationFence: facts.authorization!.authorizationFence,
                principal: input.principal,
            })
            break
        case 'cancel_preparation':
        case 'declare_outcome_unknown':
            outcome = await port.releasePayout({
                payoutAuthorizationId: facts.authorization!.id,
                authorizationFence: facts.authorization!.authorizationFence,
                kind: route.operation,
                reason: reason === '' ? MANAGER_RELEASE_REASON[route.operation] : reason,
                principal: input.principal,
            })
            break
        default:
            outcome = await port.resolveReconciliation({
                reconciliationTaskId: facts.reconciliation!.id,
                resolution: input.action === 'reconcile_paid' ? 'paid' : 'not_paid',
                resolutionEvidence: reason === '' ? MANAGER_RECONCILIATION_EVIDENCE[input.action as 'reconcile_paid' | 'reconcile_not_paid'] : reason,
                principal: input.principal,
            })
    }

    if (outcome.ok) return settled(outcome.replayed ? 'already_done' : 'performed')
    const after = await port.findApplication(input.applicationId)
    const code = managerResultForCompensationErrorV1(
        outcome.code ?? '',
        after === null ? before : stateFacts(after),
    )
    return {
        code,
        state: after === null ? null : managerApplicationStateV1(stateFacts(after)),
        applicationId: input.applicationId,
    }
}

const MANAGER_RELEASE_REASON = {
    cancel_preparation: 'Менеджер отменил одобрение до выплаты',
    declare_outcome_unknown: 'Менеджер не знает, дошла ли выплата',
} as const

const MANAGER_RECONCILIATION_EVIDENCE = {
    reconcile_paid: 'Менеджер подтвердил, что выплата дошла до водителя',
    reconcile_not_paid: 'Менеджер подтвердил, что выплата не состоялась',
} as const
