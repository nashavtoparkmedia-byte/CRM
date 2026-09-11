/**
 * State machines for the compensation monetary core.
 *
 * Application keeps exactly three statuses. The payout lifecycle is a separate
 * owner-local entity and deliberately has no stored `stale` state: staleness is
 * derived from `expiresAt` for the operator's benefit and never releases
 * anything. Nothing ages out on its own, because the CRM cannot know whether
 * money left the external dispatcher.
 */

/**
 * The single total order for every owner-local monetary row lock.
 *
 * An operation skips entity types it does not need, but it may never acquire
 * two of these in an order other than this one, and it may never lock a
 * `Contact` row at all: contact merge already locks a pair of Contact rows
 * inside a transaction that also writes Messaging and Work Management, so a
 * monetary transaction holding a Contact lock would deadlock against it.
 *
 * Finalize is the operation that proves the order has to be total rather than
 * per-command: it needs both the payout authorization and the order claim.
 */
export const COMPENSATION_LOCK_ORDER_V1 = [
    'CompensationBudgetPeriod',
    'CompensationPerson',
    'CompensationApplication',
    'CompensationPayoutAuthorization',
    'CompensationOrderClaim',
    'CompensationSettlement',
    'CompensationReconciliationTask',
] as const

export type CompensationLockableEntityV1 = typeof COMPENSATION_LOCK_ORDER_V1[number]

/** Entity types a monetary transaction must never row-lock. */
export const COMPENSATION_FORBIDDEN_LOCK_ENTITIES_V1 = ['Contact', 'ContactPhone', 'ContactIdentity'] as const

const LOCK_RANK = new Map<string, number>(
    COMPENSATION_LOCK_ORDER_V1.map((entity, index) => [entity, index]),
)

export type CompensationLockOrderErrorCodeV1 =
    | 'UNKNOWN_LOCK_ENTITY'
    | 'FORBIDDEN_LOCK_ENTITY'
    | 'LOCK_ORDER_VIOLATION'
    | 'DUPLICATE_LOCK_ENTITY'

export class CompensationLockOrderErrorV1 extends Error {
    readonly code: CompensationLockOrderErrorCodeV1
    constructor(code: CompensationLockOrderErrorCodeV1, message: string) {
        super(message)
        this.name = 'CompensationLockOrderErrorV1'
        this.code = code
    }
}

export function compensationLockRankV1(entity: string): number {
    if ((COMPENSATION_FORBIDDEN_LOCK_ENTITIES_V1 as readonly string[]).includes(entity)) {
        throw new CompensationLockOrderErrorV1(
            'FORBIDDEN_LOCK_ENTITY',
            `${entity} must never be row-locked by a compensation monetary transaction`,
        )
    }
    const rank = LOCK_RANK.get(entity)
    if (rank === undefined) {
        throw new CompensationLockOrderErrorV1('UNKNOWN_LOCK_ENTITY', `${entity} is not a compensation lock target`)
    }
    return rank
}

/**
 * Asserts an acquisition sequence obeys the frozen order. Each adapter records
 * the entity types it locks, in order, and hands the sequence here, so the
 * contract is enforced by a shared function rather than by review.
 */
export function assertCompensationLockOrderV1(sequence: readonly string[]): void {
    const seen = new Set<string>()
    let previous = -1
    for (const entity of sequence) {
        const rank = compensationLockRankV1(entity)
        if (seen.has(entity)) {
            throw new CompensationLockOrderErrorV1(
                'DUPLICATE_LOCK_ENTITY',
                `${entity} is locked twice in one transaction; lock all of its rows together in ascending id order`,
            )
        }
        if (rank <= previous) {
            throw new CompensationLockOrderErrorV1(
                'LOCK_ORDER_VIOLATION',
                `${entity} acquired after a lower-ranked lock; the frozen order is ${COMPENSATION_LOCK_ORDER_V1.join(' > ')}`,
            )
        }
        seen.add(entity)
        previous = rank
    }
}

/** Several rows of one type are always locked in ascending id order. */
export function compensationRowLockOrderV1(ids: readonly string[]): string[] {
    return [...new Set(ids)].sort()
}

export const COMPENSATION_APPLICATION_STATUSES_V1 = ['PENDING', 'PAID', 'REJECTED'] as const
export type CompensationApplicationStatusV1 = typeof COMPENSATION_APPLICATION_STATUSES_V1[number]

export const COMPENSATION_PAYOUT_AUTHORIZATION_STATES_V1 = [
    'active',
    'unknown_outcome',
    'finalized',
    'cancelled',
] as const
export type CompensationPayoutAuthorizationStateV1 =
    typeof COMPENSATION_PAYOUT_AUTHORIZATION_STATES_V1[number]

/**
 * States that hold the person's exclusive payout right and forbid REJECTED.
 * These are the states the partial unique indexes cover.
 */
export const COMPENSATION_PAYOUT_HOLD_STATES_V1 = ['active', 'unknown_outcome'] as const

/**
 * States that consume the person's daily payout slot. `finalized` is included
 * so that a completed payout keeps the day claimed for the rest of that day.
 */
export const COMPENSATION_PAYOUT_DAY_SLOT_STATES_V1 = [
    'active',
    'unknown_outcome',
    'finalized',
] as const

/** UX threshold after which the operator is warned that preparation is stale. */
export const COMPENSATION_PAYOUT_STALE_AFTER_MS = 30 * 60 * 1000
/** Beyond this age the manager can no longer honestly recall the outcome. */
export const COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS = 24 * 60 * 60 * 1000

export interface CompensationPayoutAuthorizationSnapshotV1 {
    id: string
    state: CompensationPayoutAuthorizationStateV1
    authorizationFence: string
    openedAt: Date
    expiresAt: Date
}

/** Derived, never stored. A stale authorization still holds every lock. */
export function isCompensationPayoutAuthorizationStaleV1(
    authorization: Pick<CompensationPayoutAuthorizationSnapshotV1, 'expiresAt'>,
    now: Date,
): boolean {
    return now.getTime() > authorization.expiresAt.getTime()
}

export function compensationPayoutHoldsLocksV1(state: CompensationPayoutAuthorizationStateV1): boolean {
    return (COMPENSATION_PAYOUT_HOLD_STATES_V1 as readonly string[]).includes(state)
}

export function compensationPayoutConsumesDaySlotV1(
    state: CompensationPayoutAuthorizationStateV1,
): boolean {
    return (COMPENSATION_PAYOUT_DAY_SLOT_STATES_V1 as readonly string[]).includes(state)
}

export type CompensationFinalizeDecisionV1 =
    | { kind: 'finalize' }
    | { kind: 'replay' }
    | { kind: 'refuse'; code: CompensationFinalizeRefusalCodeV1 }

export type CompensationFinalizeRefusalCodeV1 =
    | 'authorization_fenced'
    | 'authorization_released'
    | 'reconciliation_required'
    | 'authorization_too_old_reconcile'

/**
 * Whether a "confirm payout" may proceed. Age is checked here rather than in
 * the adapter so the 24-hour reconciliation cut-off is stated once.
 */
export function compensationFinalizeDecisionV1(
    authorization: CompensationPayoutAuthorizationSnapshotV1,
    presentedFence: string,
    now: Date,
    viaReconciliation = false,
): CompensationFinalizeDecisionV1 {
    if (authorization.authorizationFence !== presentedFence) {
        return { kind: 'refuse', code: 'authorization_fenced' }
    }
    if (authorization.state === 'finalized') return { kind: 'replay' }
    if (authorization.state === 'cancelled') {
        return { kind: 'refuse', code: 'authorization_released' }
    }
    if (authorization.state === 'unknown_outcome' && !viaReconciliation) {
        return { kind: 'refuse', code: 'reconciliation_required' }
    }
    // The age cut-off exists because a manager cannot honestly recall an
    // unaided outcome after a day. A reconciliation resolution is not unaided
    // recall: it carries explicit evidence and is exactly the process that
    // handles an outcome discovered late, so it is not subject to that gate.
    if (!viaReconciliation
        && now.getTime() - authorization.openedAt.getTime() > COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS) {
        return { kind: 'refuse', code: 'authorization_too_old_reconcile' }
    }
    return { kind: 'finalize' }
}

export type CompensationCancelDecisionV1 =
    | { kind: 'cancel' }
    | { kind: 'replay' }
    | { kind: 'refuse'; code: 'authorization_fenced' | 'already_finalized' | 'reconciliation_required' }

export function compensationCancelDecisionV1(
    authorization: CompensationPayoutAuthorizationSnapshotV1,
    presentedFence: string,
): CompensationCancelDecisionV1 {
    if (authorization.authorizationFence !== presentedFence) {
        return { kind: 'refuse', code: 'authorization_fenced' }
    }
    if (authorization.state === 'cancelled') return { kind: 'replay' }
    if (authorization.state === 'finalized') return { kind: 'refuse', code: 'already_finalized' }
    if (authorization.state === 'unknown_outcome') {
        return { kind: 'refuse', code: 'reconciliation_required' }
    }
    return { kind: 'cancel' }
}

export type CompensationAttemptDecisionV1 =
    | { kind: 'allow'; attemptNo: 1 | 2 }
    | {
        kind: 'refuse'
        code: 'order_already_settled' | 'max_attempts_reached' | 'second_attempt_requires_rejected_first'
    }

export interface CompensationOrderClaimSnapshotV1 {
    attemptCount: number
    settledApplicationId: string | null
    firstAttemptStatus: CompensationApplicationStatusV1 | null
}

/**
 * Attempt numbering is a product rule, separate from idempotency: it counts
 * distinct logical applications against one external order, at most two, and
 * the second only after the first was rejected.
 */
export function compensationAttemptDecisionV1(
    claim: CompensationOrderClaimSnapshotV1,
): CompensationAttemptDecisionV1 {
    if (claim.settledApplicationId !== null) {
        return { kind: 'refuse', code: 'order_already_settled' }
    }
    if (claim.attemptCount >= 2) {
        return { kind: 'refuse', code: 'max_attempts_reached' }
    }
    if (claim.attemptCount === 0) return { kind: 'allow', attemptNo: 1 }
    if (claim.firstAttemptStatus !== 'REJECTED') {
        return { kind: 'refuse', code: 'second_attempt_requires_rejected_first' }
    }
    return { kind: 'allow', attemptNo: 2 }
}
