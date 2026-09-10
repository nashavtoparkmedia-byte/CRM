import { describe, expect, it } from 'vitest'
import {
    CompensationIdentityErrorV1,
    assertCompensationIdempotencyKeyV1,
    compensationApplicationIdV1,
    compensationAuditEventIdV1,
    compensationPayoutFenceV1,
    compensationSubmitFingerprintV1,
} from './compensation-identity'
import type { CompensationOrderKeyV1 } from './compensation-ports'

const key = '3f1a9c22-5b0e-4d77-9a31-6c8e0d2f4b10'
const orderKey: CompensationOrderKeyV1 = {
    provider: 'yandex_fleet',
    externalParkId: '3a23295d8d714c03b61a17a6fc86601b',
    externalOrderId: '751911d3f0c94b2ea7d5c6081ee32b44',
}

describe('assertCompensationIdempotencyKeyV1', () => {
    it('accepts a caller-generated UUID', () => {
        expect(assertCompensationIdempotencyKeyV1(key)).toBe(key)
        expect(assertCompensationIdempotencyKeyV1(key.toUpperCase())).toBe(key)
    })

    it('refuses anything a caller could not reproduce after a timeout', () => {
        for (const raw of ['', 'not-a-uuid', key.slice(0, -1), 123, null, undefined, {}]) {
            expect(() => assertCompensationIdempotencyKeyV1(raw)).toThrowError(CompensationIdentityErrorV1)
        }
    })
})

describe('compensationApplicationIdV1', () => {
    it('is deterministic, so the database is the concurrency fence', () => {
        expect(compensationApplicationIdV1(key)).toBe(compensationApplicationIdV1(key))
        expect(compensationApplicationIdV1(key)).toMatch(/^comp_app_[0-9a-f]{64}$/)
    })

    it('separates different logical submits', () => {
        const other = '00000000-0000-4000-8000-000000000001'
        expect(compensationApplicationIdV1(key)).not.toBe(compensationApplicationIdV1(other))
    })
})

describe('compensationSubmitFingerprintV1', () => {
    const base = { compensationPersonId: 'p1', orderKey, claimedKopecks: 30_000 }

    it('is stable for the same intent', () => {
        expect(compensationSubmitFingerprintV1(base)).toBe(compensationSubmitFingerprintV1({ ...base }))
    })

    it('changes when any part of the intent changes', () => {
        const variants = [
            { ...base, compensationPersonId: 'p2' },
            { ...base, claimedKopecks: 30_001 },
            { ...base, orderKey: { ...orderKey, externalParkId: 'other' } },
            { ...base, orderKey: { ...orderKey, externalOrderId: 'other' } },
            { ...base, orderKey: { ...orderKey, provider: 'other' } },
        ]
        for (const variant of variants) {
            expect(compensationSubmitFingerprintV1(variant)).not.toBe(compensationSubmitFingerprintV1(base))
        }
    })

    it('distinguishes the same order id in two different parks', () => {
        const parkA = compensationSubmitFingerprintV1(base)
        const parkB = compensationSubmitFingerprintV1({
            ...base,
            orderKey: { ...orderKey, externalParkId: '45e30e9d6b824c608e5d28719cb19a6e' },
        })
        expect(parkA).not.toBe(parkB)
    })
})

describe('compensationPayoutFenceV1', () => {
    it('changes when the application version moves', () => {
        expect(compensationPayoutFenceV1('auth1', 0)).not.toBe(compensationPayoutFenceV1('auth1', 1))
        expect(compensationPayoutFenceV1('auth1', 0)).toMatch(/^[0-9a-f]{64}$/)
    })
})

describe('compensationAuditEventIdV1', () => {
    const input = {
        subjectType: 'CompensationApplication',
        subjectId: 'comp_app_1',
        action: 'submit',
        correlationId: key,
    }

    it('lets a retried operation append the same row once', () => {
        expect(compensationAuditEventIdV1(input)).toBe(compensationAuditEventIdV1({ ...input }))
        expect(compensationAuditEventIdV1(input)).toMatch(/^comp_aud_[0-9a-f]{64}$/)
    })

    it('separates two actions on the same subject', () => {
        expect(compensationAuditEventIdV1({ ...input, action: 'reject' }))
            .not.toBe(compensationAuditEventIdV1(input))
    })
})
