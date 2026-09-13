import { describe, expect, it, vi } from 'vitest'

import type { StoredCashOrderV1 } from './compensation-cash-order-ingestion'
import {
    compensationSectionViewV1,
    performManagerActionV1,
    submitPilotApplicationV1,
    type CompensationPilotPortV1,
    type ManagerApplicationRowV1,
    type PilotDriverIdentityV1,
} from './compensation-pilot-service'

const NOW = new Date('2026-09-20T09:00:00.000Z')
const PARK = 'park-1'
const PROFILE = 'b'.repeat(32)
const CONTACT = 'contact-1'

const ORDER: StoredCashOrderV1 = {
    id: 'row-1',
    provider: 'yandex_fleet',
    externalParkId: PARK,
    externalOrderId: 'a'.repeat(32),
    shortOrderIdDisplay: '3982091',
    externalDriverProfileId: PROFILE,
    rawPrice: '335.0000',
    amountKopecks: 33_500,
    endedAt: new Date('2026-09-12T10:00:00.000Z'),
}

const ELIGIBLE_IDENTITY: PilotDriverIdentityV1 = {
    telegramUserId: '777',
    canonicalContactId: CONTACT,
    externalParkId: PARK,
    externalDriverProfileId: PROFILE,
    facts: {
        isSelfEmployed: true,
        employmentType: 'selfemployed',
        parkHireDate: new Date('2026-09-02T06:00:00.000Z'),
    },
}

const MANAGER_ROW: ManagerApplicationRowV1 = {
    applicationId: 'app-1',
    status: 'submitted',
    externalOrderId: ORDER.externalOrderId,
    shortOrderIdDisplay: '3982091',
    claimedKopecks: 30_000,
    amountKopecks: 30_000,
    verifiedKopecks: 33_500,
    submittedAt: NOW,
    rejectionReason: null,
    canonicalContactId: CONTACT,
    externalParkId: PARK,
    telegramUserId: '777',
    attachmentFileId: 'tg-file-1',
    attachmentKind: 'photo',
    supportContactedAt: NOW,
    hasLiveAuthorization: false,
    hasOpenReconciliation: false,
    payoutAuthorizationId: null,
    authorizationFence: null,
}

function port(overrides: Partial<CompensationPilotPortV1> = {}): CompensationPilotPortV1 {
    return {
        findDriverIdentity: vi.fn(async () => ELIGIBLE_IDENTITY),
        findCashOrders: vi.fn(async () => [ORDER]),
        findBudgetPeriod: vi.fn(async () => ({ limitKopecks: 500_000, reservedKopecks: 0, settledKopecks: 0 })),
        findClaimedOrderIds: vi.fn(async () => []),
        findDriverApplications: vi.fn(async () => []),
        findManagerApplications: vi.fn(async () => [MANAGER_ROW]),
        findManagerApplication: vi.fn(async () => MANAGER_ROW),
        submitApplication: vi.fn(async () => ({ applicationId: 'app-1', amountKopecks: 30_000, status: 'created' as const })),
        startPayout: vi.fn(async () => {}),
        rejectApplication: vi.fn(async () => {}),
        finalizePayout: vi.fn(async () => {}),
        resolveReconciliation: vi.fn(async () => {}),
        ...overrides,
    }
}

describe('the compensation section a driver sees', () => {
    it('lists eligible orders with the remaining monthly budget', async () => {
        const view = await compensationSectionViewV1('777', port(), NOW)
        expect(view).toMatchObject({
            available: true,
            firstMonthKey: '2026-09',
            remainingBudgetKopecks: 500_000,
        })
        expect(view.available && view.orders).toHaveLength(1)
    })

    it('tells an unlinked account it is unlinked rather than showing an empty list', async () => {
        const view = await compensationSectionViewV1('777', port({
            findDriverIdentity: vi.fn(async () => ({ ...ELIGIBLE_IDENTITY, canonicalContactId: null })),
        }), NOW)
        expect(view).toMatchObject({ available: false, reason: 'identity_not_proven' })
    })

    it('names the eligibility reason when the driver is not park-SMZ', async () => {
        const view = await compensationSectionViewV1('777', port({
            findDriverIdentity: vi.fn(async () => ({
                ...ELIGIBLE_IDENTITY,
                facts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2026-09-02T06:00:00.000Z') },
            })),
        }), NOW)
        expect(view).toMatchObject({ available: false, reason: 'not_self_employed' })
    })

    it('still shows past applications to a driver who is no longer eligible', async () => {
        const view = await compensationSectionViewV1('777', port({
            findDriverIdentity: vi.fn(async () => ({
                ...ELIGIBLE_IDENTITY,
                facts: { isSelfEmployed: null, employmentType: null, parkHireDate: null },
            })),
            findDriverApplications: vi.fn(async () => [{
                applicationId: 'app-0', status: 'paid' as const, externalOrderId: 'x',
                shortOrderIdDisplay: null, claimedKopecks: 100, amountKopecks: 100,
                verifiedKopecks: 100, submittedAt: NOW, rejectionReason: null,
            }]),
        }), NOW)
        expect(view.available).toBe(false)
        expect(view.applications).toHaveLength(1)
    })

    it('reports zero budget rather than failing when the period is missing', async () => {
        const view = await compensationSectionViewV1('777', port({
            findBudgetPeriod: vi.fn(async () => null),
        }), NOW)
        expect(view).toMatchObject({ available: true, remainingBudgetKopecks: 0 })
    })
})

describe('submitting from the bot', () => {
    it('submits a complete claim through C1', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1({
            telegramUserId: '777',
            externalOrderId: ORDER.externalOrderId,
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'key-1',
        }, p, NOW)

        expect(outcome).toMatchObject({ submitted: true, applicationId: 'app-1', amountKopecks: 30_000 })
        expect(p.submitApplication).toHaveBeenCalledTimes(1)
    })

    it('rejects above one thousand rubles without touching C1', async () => {
        const p = port()
        const outcome = await submitPilotApplicationV1({
            telegramUserId: '777',
            externalOrderId: ORDER.externalOrderId,
            claimedRubles: 1001,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'key-1',
        }, p, NOW)

        expect(outcome).toEqual({ submitted: false, refusal: 'claim_above_pilot_cap' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses without support confirmation or an attachment', async () => {
        const p = port()
        const base = {
            telegramUserId: '777',
            externalOrderId: ORDER.externalOrderId,
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'key-1',
        }
        expect(await submitPilotApplicationV1({ ...base, supportConfirmed: false }, p, NOW))
            .toEqual({ submitted: false, refusal: 'support_not_confirmed' })
        expect(await submitPilotApplicationV1({ ...base, attachmentFileId: null }, p, NOW))
            .toEqual({ submitted: false, refusal: 'attachment_missing' })
        expect(p.submitApplication).not.toHaveBeenCalled()
    })

    it('refuses an order the freshly rebuilt catalogue no longer offers', async () => {
        // The conversation remembered an order; eligibility has since lapsed.
        const p = port({ findCashOrders: vi.fn(async () => []) })
        const outcome = await submitPilotApplicationV1({
            telegramUserId: '777',
            externalOrderId: ORDER.externalOrderId,
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'key-1',
        }, p, NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'order_not_in_catalogue' })
    })

    it('refuses a second claim on an order already claimed', async () => {
        const p = port({ findClaimedOrderIds: vi.fn(async () => [ORDER.externalOrderId]) })
        const outcome = await submitPilotApplicationV1({
            telegramUserId: '777',
            externalOrderId: ORDER.externalOrderId,
            claimedRubles: 300,
            supportConfirmed: true,
            attachmentFileId: 'tg-file-1',
            attachmentKind: 'photo',
            idempotencyKey: 'key-1',
        }, p, NOW)
        expect(outcome).toEqual({ submitted: false, refusal: 'order_already_claimed' })
    })
})

describe('manager actions reach the right C1 operation', () => {
    it('approve starts the payout', async () => {
        const p = port()
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'approve', principalId: 'm1', operatorLabel: 'Manager',
        }, p)
        expect(outcome).toEqual({ performed: true, operation: 'start_payout' })
        expect(p.startPayout).toHaveBeenCalledWith({
            applicationId: 'app-1', principalId: 'm1', operatorLabel: 'Manager',
        })
    })

    it('mark paid finalizes using the stored authorization evidence', async () => {
        const p = port({
            findManagerApplication: vi.fn(async () => ({
                ...MANAGER_ROW,
                hasLiveAuthorization: true,
                payoutAuthorizationId: 'auth-1',
                authorizationFence: 'fence-1',
            })),
        })
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'mark_paid', principalId: 'm1', operatorLabel: 'Manager',
        }, p)
        expect(outcome).toEqual({ performed: true, operation: 'finalize_payout' })
        expect(p.finalizePayout).toHaveBeenCalledWith({
            payoutAuthorizationId: 'auth-1', authorizationFence: 'fence-1',
            principalId: 'm1', operatorLabel: 'Manager',
        })
    })

    it('routes a lost outcome to reconciliation instead of finalize', async () => {
        const p = port({
            findManagerApplication: vi.fn(async () => ({ ...MANAGER_ROW, hasOpenReconciliation: true })),
        })
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'mark_paid', principalId: 'm1', operatorLabel: 'Manager',
        }, p)
        expect(outcome).toEqual({ performed: true, operation: 'resolve_reconciliation' })
        expect(p.finalizePayout).not.toHaveBeenCalled()
    })

    it('refuses to reject while a payout is in flight', async () => {
        const p = port({
            findManagerApplication: vi.fn(async () => ({ ...MANAGER_ROW, hasLiveAuthorization: true })),
        })
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'reject', principalId: 'm1', operatorLabel: 'M', reason: 'no',
        }, p)
        expect(outcome).toEqual({ performed: false, refusal: 'reject_requires_no_live_authorization' })
        expect(p.rejectApplication).not.toHaveBeenCalled()
    })

    it('requires a reason to reject', async () => {
        const p = port()
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'reject', principalId: 'm1', operatorLabel: 'M', reason: '   ',
        }, p)
        expect(outcome).toEqual({ performed: false, refusal: 'reject_requires_reason' })
        expect(p.rejectApplication).not.toHaveBeenCalled()
    })

    it('refuses an action on an application that does not exist', async () => {
        const p = port({ findManagerApplication: vi.fn(async () => null) })
        const outcome = await performManagerActionV1({
            applicationId: 'missing', action: 'approve', principalId: 'm1', operatorLabel: null,
        }, p)
        expect(outcome).toEqual({ performed: false, refusal: 'application_not_found' })
    })

    it('never finalizes an application that was never approved', async () => {
        const p = port()
        const outcome = await performManagerActionV1({
            applicationId: 'app-1', action: 'mark_paid', principalId: 'm1', operatorLabel: null,
        }, p)
        expect(outcome).toEqual({ performed: false, refusal: 'mark_paid_requires_authorization' })
        expect(p.finalizePayout).not.toHaveBeenCalled()
    })
})
