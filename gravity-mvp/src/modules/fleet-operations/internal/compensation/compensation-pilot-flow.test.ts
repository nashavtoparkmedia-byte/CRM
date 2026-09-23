import { describe, expect, it } from 'vitest'

import type { StoredCashOrderV1 } from './compensation-cash-order-ingestion'
import {
    decidePilotSubmissionV1,
    pilotDriverStatusV1,
    remainingBudgetKopecksV1,
    PILOT_MAX_CLAIMED_RUBLES,
    type PilotSubmissionContextV1,
    type PilotSubmissionRequestV1,
} from './compensation-pilot-flow'

const ORDER: StoredCashOrderV1 = {
    id: 'row-1',
    provider: 'yandex_fleet',
    externalParkId: 'park-1',
    externalOrderId: 'a'.repeat(32),
    shortOrderIdDisplay: '3982091',
    externalDriverProfileId: 'b'.repeat(32),
    rawPrice: '335.0000',
    amountKopecks: 33_500,
    endedAt: new Date('2026-09-12T10:00:00.000Z'),
}

function request(overrides: Partial<PilotSubmissionRequestV1> = {}): PilotSubmissionRequestV1 {
    return {
        externalOrderId: ORDER.externalOrderId,
        claimedRubles: 300,
        supportConfirmed: true,
        attachmentFileId: 'tg-file-1',
        attachmentKind: 'photo',
        ...overrides,
    }
}

function context(overrides: Partial<PilotSubmissionContextV1> = {}): PilotSubmissionContextV1 {
    return {
        catalogue: [ORDER],
        alreadyClaimedOrderIds: [],
        remainingBudgetKopecks: 500_000,
        ...overrides,
    }
}

describe('pilot submission gate', () => {
    it('accepts a complete claim', () => {
        const decision = decidePilotSubmissionV1(request(), context())
        expect(decision).toMatchObject({ accepted: true, claimedRubles: 300, attachmentFileId: 'tg-file-1' })
    })

    it('refuses until the driver confirms they contacted support', () => {
        expect(decidePilotSubmissionV1(request({ supportConfirmed: false }), context()))
            .toEqual({ accepted: false, refusal: 'support_not_confirmed' })
    })

    it('refuses without the support response attached', () => {
        expect(decidePilotSubmissionV1(request({ attachmentFileId: null }), context()))
            .toEqual({ accepted: false, refusal: 'attachment_missing' })
        expect(decidePilotSubmissionV1(request({ attachmentFileId: '   ' }), context()))
            .toEqual({ accepted: false, refusal: 'attachment_missing' })
    })

    it('caps the claim at one thousand rubles', () => {
        expect(PILOT_MAX_CLAIMED_RUBLES).toBe(1000)
        expect(decidePilotSubmissionV1(request({ claimedRubles: 1000 }), context()))
            .toMatchObject({ accepted: true })
        expect(decidePilotSubmissionV1(request({ claimedRubles: 1001 }), context()))
            .toEqual({ accepted: false, refusal: 'claim_above_pilot_cap' })
    })

    it('refuses a fractional or non-positive claim', () => {
        expect(decidePilotSubmissionV1(request({ claimedRubles: 10.5 }), context()))
            .toEqual({ accepted: false, refusal: 'claim_not_whole_rubles' })
        expect(decidePilotSubmissionV1(request({ claimedRubles: 0 }), context()))
            .toEqual({ accepted: false, refusal: 'claim_below_minimum' })
    })

    it('refuses an order the driver was never shown', () => {
        expect(decidePilotSubmissionV1(request({ externalOrderId: 'z'.repeat(32) }), context()))
            .toEqual({ accepted: false, refusal: 'order_not_in_catalogue' })
    })

    it('refuses a second claim on the same order', () => {
        const decision = decidePilotSubmissionV1(
            request(), context({ alreadyClaimedOrderIds: [ORDER.externalOrderId] }),
        )
        expect(decision).toEqual({ accepted: false, refusal: 'order_already_claimed' })
    })

    it('refuses when the park budget cannot cover the payable amount', () => {
        expect(decidePilotSubmissionV1(request({ claimedRubles: 300 }), context({ remainingBudgetKopecks: 29_999 })))
            .toEqual({ accepted: false, refusal: 'budget_exhausted' })
    })

    it('measures the budget against the payable amount, not the raw claim', () => {
        // Claim 1000 against a 335 order: only 335 will ever be paid, so a
        // budget of 400 is enough and refusing would be wrong.
        const decision = decidePilotSubmissionV1(
            request({ claimedRubles: 1000 }), context({ remainingBudgetKopecks: 40_000 }),
        )
        expect(decision).toMatchObject({ accepted: true })
    })
})

describe('driver-facing status', () => {
    it('reads a pending application with no authorization as submitted', () => {
        expect(pilotDriverStatusV1({ status: 'PENDING', hasLiveAuthorization: false })).toBe('submitted')
    })

    it('reads a pending application holding an authorization as awaiting payment', () => {
        expect(pilotDriverStatusV1({ status: 'PENDING', hasLiveAuthorization: true })).toBe('awaiting_payment')
    })

    it('reads the terminal states directly', () => {
        expect(pilotDriverStatusV1({ status: 'PAID', hasLiveAuthorization: false })).toBe('paid')
        expect(pilotDriverStatusV1({ status: 'REJECTED', hasLiveAuthorization: false })).toBe('rejected')
    })
})

describe('remaining budget', () => {
    it('subtracts both reserved and settled', () => {
        expect(remainingBudgetKopecksV1({ limitKopecks: 100_000, reservedKopecks: 30_000, settledKopecks: 20_000 }))
            .toBe(50_000)
    })

    it('never reports a negative remainder', () => {
        expect(remainingBudgetKopecksV1({ limitKopecks: 10_000, reservedKopecks: 9_000, settledKopecks: 5_000 }))
            .toBe(0)
    })
})
