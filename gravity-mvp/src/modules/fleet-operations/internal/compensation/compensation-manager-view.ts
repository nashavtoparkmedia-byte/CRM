/**
 * What a manager sees and may do, as decisions.
 *
 * The monetary truth is C1's: three application statuses and a separate payout
 * authorization lifecycle. A manager screen needs one word for the pair, so the
 * projection below derives it and nothing stores it. Every rule about which
 * action is offered, what a refusal means and how a budget reads is stated
 * here, so the screen renders and decides nothing.
 *
 * Concurrency is C1's too. This module never compares a remembered version:
 * an approval or a rejection is validated against the row C1 locks, and a
 * payout operation presents the authorization fence C1 compares under that
 * lock. What is decided here is only how the answer is worded.
 */

import { compensationCalendarMonthV1, compensationPeriodKeyV1 } from './compensation-calendar'
import { compensationBusinessDisplayV1, type CompensationBusinessDisplayV1 } from './compensation-pilot-selection'

export const MANAGER_APPLICATION_STATES_V1 = [
    'new',
    'awaiting_payment',
    'reconciliation',
    'paid',
    'rejected',
] as const
export type ManagerApplicationStateV1 = typeof MANAGER_APPLICATION_STATES_V1[number]

export type ManagerAuthorizationStateV1 = 'active' | 'unknown_outcome' | 'finalized' | 'cancelled'

export interface ManagerStateFactsV1 {
    /** C1 application status. */
    status: string
    /** The live authorization, when one is open. */
    authorizationState: ManagerAuthorizationStateV1 | null
    hasOpenReconciliation: boolean
}

/**
 * The one word for the pair (application status, payout lifecycle).
 *
 * PAID and REJECTED are settled facts. A PENDING application is new until a
 * payout right is open on it, awaiting payment while that right is live, and
 * in reconciliation once C1 has lost sight of the outcome.
 */
export function managerApplicationStateV1(facts: ManagerStateFactsV1): ManagerApplicationStateV1 {
    if (facts.status === 'PAID') return 'paid'
    if (facts.status === 'REJECTED') return 'rejected'
    if (facts.authorizationState === 'unknown_outcome' && facts.hasOpenReconciliation) return 'reconciliation'
    if (facts.authorizationState === 'active') return 'awaiting_payment'
    return 'new'
}

export const MANAGER_ACTIONS_V1 = [
    'approve',
    'reject',
    'mark_paid',
    'cancel_approval',
    'declare_outcome_unknown',
    'reconcile_paid',
    'reconcile_not_paid',
] as const
export type ManagerActionV1 = typeof MANAGER_ACTIONS_V1[number]

/** Whether the support screenshot can be shown to the manager at all. */
export type ManagerEvidenceStateV1 = 'present' | 'missing'

export interface ManagerActionAvailabilityFactsV1 extends ManagerStateFactsV1 {
    evidence: ManagerEvidenceStateV1
}

/**
 * The actions this application is currently open to.
 *
 * Approving is the one decision the evidence gates: a claim with no usable
 * support reply may only be rejected. Once money is already authorised, an
 * evidence problem never strands the monetary state, so paying, cancelling,
 * declaring the outcome unknown and resolving a reconciliation stay available.
 */
export function managerAllowedActionsV1(facts: ManagerActionAvailabilityFactsV1): ManagerActionV1[] {
    switch (managerApplicationStateV1(facts)) {
        case 'new':
            return facts.evidence === 'present' ? ['approve', 'reject'] : ['reject']
        case 'awaiting_payment':
            return ['mark_paid', 'cancel_approval', 'declare_outcome_unknown']
        case 'reconciliation':
            return ['reconcile_paid', 'reconcile_not_paid']
        default:
            return []
    }
}

export const MANAGER_RESULT_CODES_V1 = [
    'performed',
    'already_done',
    'application_not_found',
    'state_changed',
    'already_approved',
    'already_paid',
    'already_rejected',
    'evidence_missing',
    'evidence_unavailable',
    'reject_requires_reason',
    'payout_authorization_active',
    'another_payout_in_progress',
    'daily_limit_reached',
    'authorization_too_old_reconcile',
    'reconciliation_required',
    'reconciliation_not_open',
    'person_reconciliation_required',
    'budget_period_missing',
    'clock_skew',
    'not_authenticated',
    'user_disabled',
    'user_identity_incomplete',
    'role_not_allowed',
    'unavailable',
] as const
export type ManagerResultCodeV1 = typeof MANAGER_RESULT_CODES_V1[number]

/**
 * Which C1 operation an action asks for, or why it cannot be asked at all.
 *
 * The refusals here are only the ones visible before C1 is reached; C1 revalidates
 * every one of them under its own row locks, and its answer is authoritative.
 */
export type ManagerRoutingV1 =
    | { operation: 'start_payout' | 'reject_application' | 'finalize_payout' | 'cancel_preparation' | 'declare_outcome_unknown' | 'reconcile' }
    | { refusal: ManagerResultCodeV1 }

export function routeManagerActionV1(
    action: ManagerActionV1,
    facts: ManagerActionAvailabilityFactsV1,
): ManagerRoutingV1 {
    const state = managerApplicationStateV1(facts)
    if (state === 'paid') return { refusal: 'already_paid' }
    if (state === 'rejected') return { refusal: 'already_rejected' }
    if (!managerAllowedActionsV1(facts).includes(action)) {
        if (action === 'approve' && state === 'new') return { refusal: 'evidence_missing' }
        if (action === 'approve' && state === 'awaiting_payment') return { refusal: 'already_approved' }
        // Rejecting money that is already authorised is the one refusal worth
        // naming: it is what the monetary core answers too, so the screen says
        // the same thing whether the race was seen here or under its locks.
        if (action === 'reject' && (state === 'awaiting_payment' || state === 'reconciliation')) {
            return { refusal: 'payout_authorization_active' }
        }
        return { refusal: 'state_changed' }
    }
    switch (action) {
        case 'approve':
            return { operation: 'start_payout' }
        case 'reject':
            return { operation: 'reject_application' }
        case 'mark_paid':
            return { operation: 'finalize_payout' }
        case 'cancel_approval':
            return { operation: 'cancel_preparation' }
        case 'declare_outcome_unknown':
            return { operation: 'declare_outcome_unknown' }
        default:
            return { operation: 'reconcile' }
    }
}

/**
 * A monetary-core refusal, in words a manager screen can act on.
 *
 * `not_pending` is the one code that needs the row to explain it: the
 * application moved, and which way it moved is what the manager needs to know.
 */
export function managerResultForCompensationErrorV1(
    code: string,
    facts: ManagerStateFactsV1,
): ManagerResultCodeV1 {
    switch (code) {
        case 'not_pending': {
            const state = managerApplicationStateV1(facts)
            if (state === 'paid') return 'already_paid'
            if (state === 'rejected') return 'already_rejected'
            return 'state_changed'
        }
        case 'application_not_found':
            return 'application_not_found'
        case 'payout_authorization_active':
            return 'payout_authorization_active'
        case 'another_payout_in_progress':
            return 'another_payout_in_progress'
        case 'daily_limit_reached':
            return 'daily_limit_reached'
        case 'authorization_too_old_reconcile':
            return 'authorization_too_old_reconcile'
        case 'reconciliation_required':
            return 'reconciliation_required'
        case 'reconciliation_not_open':
            return 'reconciliation_not_open'
        case 'person_reconciliation_required':
            return 'person_reconciliation_required'
        case 'already_finalized':
        case 'order_already_settled':
            return 'already_paid'
        // A fence the row no longer carries, a released or unknown
        // authorization: in every case the state moved under the manager.
        case 'authorization_fenced':
        case 'authorization_released':
        case 'unknown_authorization':
            return 'state_changed'
        case 'period_missing':
        case 'period_not_open':
            return 'budget_period_missing'
        case 'payout_clock_skew':
            return 'clock_skew'
        default:
            return 'unavailable'
    }
}

export interface ManagerBudgetFactsV1 {
    periodKey: string
    state: string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
    /** Sum of the amounts of every PENDING application in this period. */
    pendingSumKopecks: number
    /** The part of that sum whose payout right is already live. */
    awaitingPaymentKopecks: number
    /** Sum of this period's settlements. */
    settlementSumKopecks: number
    counts: Record<ManagerApplicationStateV1, number>
    paidCount: number
}

export interface ManagerBudgetViewV1 {
    periodKey: string
    /** `missing` when no period row exists for the month at all. */
    state: 'missing' | string
    limitKopecks: number
    reservedKopecks: number
    settledKopecks: number
    remainingKopecks: number
    awaitingPaymentKopecks: number
    applicationCount: number
    paidCount: number
    counts: Record<ManagerApplicationStateV1, number>
    /**
     * Whether the ledger counters still agree with the applications and
     * settlements behind them. False is shown, never repaired.
     */
    ledgerConsistent: boolean
}

const EMPTY_COUNTS: Record<ManagerApplicationStateV1, number> = {
    new: 0, awaiting_payment: 0, reconciliation: 0, paid: 0, rejected: 0,
}

/**
 * The month as the dashboard shows it. Remaining is the monetary core's own
 * arithmetic, never a second formula, and a missing period is a fact of its
 * own rather than a zero budget.
 */
export function managerBudgetViewV1(
    periodKey: string,
    facts: ManagerBudgetFactsV1 | null,
): ManagerBudgetViewV1 {
    if (facts === null) {
        return {
            periodKey,
            state: 'missing',
            limitKopecks: 0,
            reservedKopecks: 0,
            settledKopecks: 0,
            remainingKopecks: 0,
            awaitingPaymentKopecks: 0,
            applicationCount: 0,
            paidCount: 0,
            counts: { ...EMPTY_COUNTS },
            ledgerConsistent: true,
        }
    }
    const counts = { ...EMPTY_COUNTS, ...facts.counts }
    return {
        periodKey: facts.periodKey,
        state: facts.state,
        limitKopecks: facts.limitKopecks,
        reservedKopecks: facts.reservedKopecks,
        settledKopecks: facts.settledKopecks,
        remainingKopecks: Math.max(0, facts.limitKopecks - facts.reservedKopecks - facts.settledKopecks),
        awaitingPaymentKopecks: facts.awaitingPaymentKopecks,
        applicationCount: Object.values(counts).reduce((total, value) => total + value, 0),
        paidCount: facts.paidCount,
        counts,
        ledgerConsistent: facts.reservedKopecks === facts.pendingSumKopecks
            && facts.settledKopecks === facts.settlementSumKopecks,
    }
}

/**
 * The budget month an instant belongs to, on the same business calendar the
 * monetary core uses, so the dashboard and the ledger never disagree about
 * which month it is.
 */
export function managerCurrentPeriodKeyV1(now: Date): string {
    return compensationPeriodKeyV1(compensationCalendarMonthV1(now))
}

export const MANAGER_PAGE_SIZE_V1 = 25
export const MANAGER_PAGE_SIZE_MAX_V1 = 100

export interface ManagerListFilterInputV1 {
    periodKey?: string | null
    state?: string | null
    externalParkId?: string | null
    cursor?: string | null
    limit?: number | null
}

export interface ManagerListFilterV1 {
    periodKey: string | null
    state: ManagerApplicationStateV1 | null
    externalParkId: string | null
    cursor: { submittedAt: Date; applicationId: string } | null
    limit: number
}

const PERIOD_KEY = /^\d{4}-(0[1-9]|1[0-2])$/u

/** The cursor is the sort key itself, so a page break cannot skip or repeat a row. */
export function encodeManagerCursorV1(row: { submittedAt: Date; applicationId: string }): string {
    return Buffer.from(`${row.submittedAt.toISOString()}|${row.applicationId}`, 'utf8').toString('base64url')
}

export function decodeManagerCursorV1(cursor: string): { submittedAt: Date; applicationId: string } | null {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const separator = raw.indexOf('|')
    if (separator <= 0) return null
    const submittedAt = new Date(raw.slice(0, separator))
    const applicationId = raw.slice(separator + 1)
    if (Number.isNaN(submittedAt.getTime()) || applicationId === '') return null
    return { submittedAt, applicationId }
}

/** Everything a filter may say, and nothing it may not. An unreadable value is dropped. */
export function normalizeManagerFilterV1(input: ManagerListFilterInputV1 = {}): ManagerListFilterV1 {
    const text = (value: string | null | undefined) => (
        typeof value === 'string' && value.trim() !== '' ? value.trim() : null
    )
    const periodKey = text(input.periodKey)
    const state = text(input.state)
    const cursor = text(input.cursor)
    const limit = typeof input.limit === 'number' && Number.isInteger(input.limit) && input.limit > 0
        ? Math.min(input.limit, MANAGER_PAGE_SIZE_MAX_V1)
        : MANAGER_PAGE_SIZE_V1
    return {
        periodKey: periodKey !== null && PERIOD_KEY.test(periodKey) ? periodKey : null,
        state: state !== null && (MANAGER_APPLICATION_STATES_V1 as readonly string[]).includes(state)
            ? state as ManagerApplicationStateV1
            : null,
        externalParkId: text(input.externalParkId),
        cursor: cursor === null ? null : decodeManagerCursorV1(cursor),
        limit,
    }
}

/** How long a payout right has been open, and whether C1 will still finalize it unaided. */
export interface ManagerAuthorizationAgeV1 {
    ageMs: number
    /** Past this, C1 refuses an unaided finalize and asks for reconciliation. */
    beyondUnaidedRecall: boolean
    /** Derived, never stored: preparation older than the staleness threshold. */
    stale: boolean
}

export function managerAuthorizationAgeV1(
    authorization: { openedAt: Date; expiresAt: Date },
    now: Date,
    maxUnaidedAgeMs: number,
): ManagerAuthorizationAgeV1 {
    const ageMs = Math.max(0, now.getTime() - authorization.openedAt.getTime())
    return {
        ageMs,
        beyondUnaidedRecall: ageMs > maxUnaidedAgeMs,
        stale: now.getTime() > authorization.expiresAt.getTime(),
    }
}

export { compensationBusinessDisplayV1 }
export type { CompensationBusinessDisplayV1 }
