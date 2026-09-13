import { describe, expect, it } from 'vitest'
import {
    COMPENSATION_FORBIDDEN_LOCK_ENTITIES_V1,
    COMPENSATION_LOCK_ORDER_V1,
    CompensationLockOrderErrorV1,
    assertCompensationLockOrderV1,
    compensationLockRankV1,
    compensationRowLockOrderV1,
    COMPENSATION_PAYOUT_AUTHORIZATION_STATES_V1,
    COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS,
    COMPENSATION_PAYOUT_STALE_AFTER_MS,
    compensationAttemptDecisionV1,
    compensationCancelDecisionV1,
    compensationFinalizeDecisionV1,
    compensationPayoutConsumesDaySlotV1,
    compensationPayoutHoldsLocksV1,
    isCompensationPayoutAuthorizationStaleV1,
    type CompensationPayoutAuthorizationSnapshotV1,
} from './compensation-policy'

const openedAt = new Date('2026-09-10T18:00:00.000Z')

function authorization(
    overrides: Partial<CompensationPayoutAuthorizationSnapshotV1> = {},
): CompensationPayoutAuthorizationSnapshotV1 {
    return {
        id: 'auth1',
        state: 'active',
        authorizationFence: 'fence1',
        openedAt,
        expiresAt: new Date(openedAt.getTime() + COMPENSATION_PAYOUT_STALE_AFTER_MS),
        ...overrides,
    }
}

describe('monetary lock order', () => {
    it('freezes one total order for every lockable entity', () => {
        expect([...COMPENSATION_LOCK_ORDER_V1]).toEqual([
            'CompensationBudgetPeriod',
            'CompensationPerson',
            'CompensationApplication',
            'CompensationPayoutAuthorization',
            'CompensationOrderClaim',
            'CompensationSettlement',
            'CompensationReconciliationTask',
        ])
    })

    it('accepts the sequences the five monetary operations actually use', () => {
        const submit = ['CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication', 'CompensationOrderClaim']
        const startPayout = ['CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication', 'CompensationPayoutAuthorization']
        // Finalize is why the order must be total: it needs both 4 and 5.
        const finalize = [
            'CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication',
            'CompensationPayoutAuthorization', 'CompensationOrderClaim',
        ]
        const release = ['CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication', 'CompensationPayoutAuthorization']
        const reject = ['CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication', 'CompensationPayoutAuthorization']
        const reconcile = [
            'CompensationBudgetPeriod', 'CompensationPerson', 'CompensationApplication',
            'CompensationPayoutAuthorization', 'CompensationOrderClaim', 'CompensationReconciliationTask',
        ]
        for (const sequence of [submit, startPayout, finalize, release, reject, reconcile]) {
            expect(() => assertCompensationLockOrderV1(sequence)).not.toThrow()
        }
    })

    it('rejects any reverse acquisition', () => {
        expect(() => assertCompensationLockOrderV1(['CompensationOrderClaim', 'CompensationPayoutAuthorization']))
            .toThrowError(CompensationLockOrderErrorV1)
        expect(() => assertCompensationLockOrderV1(['CompensationPerson', 'CompensationBudgetPeriod']))
            .toThrowError(CompensationLockOrderErrorV1)
        expect(() => assertCompensationLockOrderV1(['CompensationApplication', 'CompensationPerson']))
            .toThrowError(CompensationLockOrderErrorV1)
    })

    it('rejects locking one entity type twice instead of batching its rows', () => {
        expect(() => assertCompensationLockOrderV1(['CompensationPerson', 'CompensationPerson']))
            .toThrowError(CompensationLockOrderErrorV1)
    })

    it('refuses a Contact row lock outright', () => {
        for (const entity of COMPENSATION_FORBIDDEN_LOCK_ENTITIES_V1) {
            expect(() => compensationLockRankV1(entity)).toThrowError(CompensationLockOrderErrorV1)
            expect(() => assertCompensationLockOrderV1(['CompensationPerson', entity]))
                .toThrowError(CompensationLockOrderErrorV1)
        }
    })

    it('refuses an entity that is not a declared lock target', () => {
        expect(() => compensationLockRankV1('Driver')).toThrowError(CompensationLockOrderErrorV1)
    })

    it('orders several rows of one type by ascending id', () => {
        expect(compensationRowLockOrderV1(['p2', 'p1', 'p2'])).toEqual(['p1', 'p2'])
    })
})

describe('payout authorization states', () => {
    it('has no stored stale state', () => {
        expect([...COMPENSATION_PAYOUT_AUTHORIZATION_STATES_V1])
            .toEqual(['active', 'unknown_outcome', 'finalized', 'cancelled'])
    })

    it('derives staleness from expiresAt', () => {
        const auth = authorization()
        expect(isCompensationPayoutAuthorizationStaleV1(auth, new Date(auth.expiresAt.getTime() - 1))).toBe(false)
        expect(isCompensationPayoutAuthorizationStaleV1(auth, new Date(auth.expiresAt.getTime() + 1))).toBe(true)
    })

    it('holds the person payout lock while active or unresolved', () => {
        expect(compensationPayoutHoldsLocksV1('active')).toBe(true)
        expect(compensationPayoutHoldsLocksV1('unknown_outcome')).toBe(true)
        expect(compensationPayoutHoldsLocksV1('finalized')).toBe(false)
        expect(compensationPayoutHoldsLocksV1('cancelled')).toBe(false)
    })

    it('keeps the daily slot claimed once a payout has been finalized', () => {
        expect(compensationPayoutConsumesDaySlotV1('active')).toBe(true)
        expect(compensationPayoutConsumesDaySlotV1('unknown_outcome')).toBe(true)
        expect(compensationPayoutConsumesDaySlotV1('finalized')).toBe(true)
        expect(compensationPayoutConsumesDaySlotV1('cancelled')).toBe(false)
    })
})

describe('compensationFinalizeDecisionV1', () => {
    const soon = new Date(openedAt.getTime() + 5 * 60 * 1000)

    it('finalizes a fresh active authorization', () => {
        expect(compensationFinalizeDecisionV1(authorization(), 'fence1', soon)).toEqual({ kind: 'finalize' })
    })

    it('still finalizes past the stale threshold, because staleness releases nothing', () => {
        const late = new Date(openedAt.getTime() + COMPENSATION_PAYOUT_STALE_AFTER_MS + 60_000)
        const auth = authorization()
        expect(isCompensationPayoutAuthorizationStaleV1(auth, late)).toBe(true)
        expect(compensationFinalizeDecisionV1(auth, 'fence1', late)).toEqual({ kind: 'finalize' })
    })

    it('replays a finalized authorization instead of settling twice', () => {
        expect(compensationFinalizeDecisionV1(authorization({ state: 'finalized' }), 'fence1', soon))
            .toEqual({ kind: 'replay' })
    })

    it('refuses a released authorization', () => {
        expect(compensationFinalizeDecisionV1(authorization({ state: 'cancelled' }), 'fence1', soon))
            .toEqual({ kind: 'refuse', code: 'authorization_released' })
    })

    it('refuses while the outcome is unknown', () => {
        expect(compensationFinalizeDecisionV1(authorization({ state: 'unknown_outcome' }), 'fence1', soon))
            .toEqual({ kind: 'refuse', code: 'reconciliation_required' })
    })

    it('refuses a stale fence before anything else', () => {
        expect(compensationFinalizeDecisionV1(authorization({ state: 'finalized' }), 'other', soon))
            .toEqual({ kind: 'refuse', code: 'authorization_fenced' })
    })

    it('sends anything older than 24 hours to reconciliation', () => {
        const tooLate = new Date(openedAt.getTime() + COMPENSATION_PAYOUT_FAST_FINALIZE_MAX_AGE_MS + 1)
        expect(compensationFinalizeDecisionV1(authorization(), 'fence1', tooLate))
            .toEqual({ kind: 'refuse', code: 'authorization_too_old_reconcile' })
    })
})

describe('compensationCancelDecisionV1', () => {
    it('cancels an active authorization', () => {
        expect(compensationCancelDecisionV1(authorization(), 'fence1')).toEqual({ kind: 'cancel' })
    })

    it('replays a cancelled authorization', () => {
        expect(compensationCancelDecisionV1(authorization({ state: 'cancelled' }), 'fence1'))
            .toEqual({ kind: 'replay' })
    })

    it('refuses to cancel after finalization', () => {
        expect(compensationCancelDecisionV1(authorization({ state: 'finalized' }), 'fence1'))
            .toEqual({ kind: 'refuse', code: 'already_finalized' })
    })

    it('refuses to cancel an unknown outcome without reconciliation', () => {
        expect(compensationCancelDecisionV1(authorization({ state: 'unknown_outcome' }), 'fence1'))
            .toEqual({ kind: 'refuse', code: 'reconciliation_required' })
    })
})

describe('compensationAttemptDecisionV1', () => {
    it('allows a first attempt', () => {
        expect(compensationAttemptDecisionV1({
            attemptCount: 0, settledApplicationId: null, firstAttemptStatus: null,
        })).toEqual({ kind: 'allow', attemptNo: 1 })
    })

    it('allows a second attempt only after a rejection', () => {
        expect(compensationAttemptDecisionV1({
            attemptCount: 1, settledApplicationId: null, firstAttemptStatus: 'REJECTED',
        })).toEqual({ kind: 'allow', attemptNo: 2 })

        expect(compensationAttemptDecisionV1({
            attemptCount: 1, settledApplicationId: null, firstAttemptStatus: 'PENDING',
        })).toEqual({ kind: 'refuse', code: 'second_attempt_requires_rejected_first' })
    })

    it('refuses a third attempt', () => {
        expect(compensationAttemptDecisionV1({
            attemptCount: 2, settledApplicationId: null, firstAttemptStatus: 'REJECTED',
        })).toEqual({ kind: 'refuse', code: 'max_attempts_reached' })
    })

    it('refuses once the order has been settled', () => {
        expect(compensationAttemptDecisionV1({
            attemptCount: 1, settledApplicationId: 'app1', firstAttemptStatus: 'PAID',
        })).toEqual({ kind: 'refuse', code: 'order_already_settled' })
    })
})
