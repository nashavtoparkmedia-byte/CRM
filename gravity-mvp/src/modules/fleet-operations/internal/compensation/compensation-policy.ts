/**
 * State machines for the compensation monetary core.
 *
 * Application keeps exactly three statuses. The payout lifecycle is a separate
 * owner-local entity and deliberately has no stored `stale` state: staleness is
 * derived from `expiresAt` for the operator's benefit and never releases
 * anything. Nothing ages out on its own, because the CRM cannot know whether
 * money left the external dispatcher.
 */

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
): CompensationFinalizeDecisionV1 {
    if (authorization.authorizationFence !== presentedFence) {
        return { kind: 'refuse', code: 'authorization_fenced' }
    }
    if (authorization.state === 'finalized') return { kind: 'replay' }
    if (authorization.state === 'cancelled') {
        return { kind: 'refuse', code: 'authorization_released' }
    }
    if (authorization.state === 'unknown_outcome') {
        return { kind: 'refuse', code: 'reconciliation_required' }
    }
    if (now.getTime() - authorization.openedAt.getTime() > COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS) {
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
