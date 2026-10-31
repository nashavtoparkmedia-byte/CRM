import { describe, expect, it } from 'vitest'

import { CASH_ACCESS_MANAGE_CAPABILITY_V1, decideCashAccessV1 } from './compensation-access'
import { CASH_REFERRAL_QUALIFY_CAPABILITY_V1 } from './compensation-referral-qualification'
import {
    CASH_ACCESS_EVENT_KINDS_V1,
    CASH_ACCESS_EVENT_WRITER_V1,
    cashAccessEventHashV1,
    cashAccessWriterAllowedV1,
    foldCashAccessLedgerV1,
    keptCashReferralDismissalsV1,
    latestCashReferralSanctionV1,
    verifyCashAccessChainV1,
    type CashAccessEventKindV1,
    type CashAccessEventV1,
} from './compensation-referral-ledger'

const LINEAGE = 'lineage:current'
const T0 = Date.parse('2026-11-05T06:00:00.000Z')

type Draft = Partial<Omit<CashAccessEventV1, 'seq' | 'prevHash' | 'hash'>> & { kind: CashAccessEventKindV1 }

function staff(capability: string) {
    return { actorKind: 'signed_staff_session' as const, actorId: 'staff:manager-1', actorCapability: capability, reason: 'checked the park documents' }
}

/** A well-formed chain: each row hashed and linked the way the writer does it. */
function chain(drafts: readonly Draft[]): CashAccessEventV1[] {
    const rows: CashAccessEventV1[] = []
    drafts.forEach((draft, index) => {
        const writer = CASH_ACCESS_EVENT_WRITER_V1[draft.kind]
        const base = writer.actorKind === 'system'
            ? { actorKind: 'system' as const, actorId: 'system:fleet', actorCapability: null, reason: null }
            : staff(writer.capability)
        const row = {
            chainContactId: 'contact-1',
            seq: index + 1,
            lineageDigest: LINEAGE,
            codeHash: null,
            attributionId: null,
            payload: {},
            idempotencyKey: `key-${index + 1}`,
            occurredAt: new Date(T0 + index * 3_600_000),
            ...base,
            ...draft,
            prevHash: index === 0 ? null : rows[index - 1].hash,
        }
        rows.push({ ...row, hash: cashAccessEventHashV1(row) })
    })
    return rows
}

describe('the hash chain detects tampering', () => {
    const rows = chain([
        { kind: 'referral_code_issued', codeHash: 'a'.repeat(64) },
        { kind: 'referral_captured', attributionId: 'attr-1' },
        { kind: 'referral_decided', attributionId: 'attr-1', payload: { outcome: 'qualified', via: 'new_park_smz' } },
        { kind: 'referral_entitlement_granted', attributionId: 'attr-1' },
    ])

    it('accepts an intact chain', () => {
        expect(verifyCashAccessChainV1(rows)).toEqual({ ok: true, length: 4 })
        expect(verifyCashAccessChainV1([...rows].reverse())).toEqual({ ok: true, length: 4 })
    })

    it('finds an edited, forged, deleted or resequenced row', () => {
        const edited = rows.map((row) => (row.seq === 3 ? { ...row, payload: { outcome: 'qualified', via: 'manager_sanction' } } : row))
        expect(verifyCashAccessChainV1(edited)).toEqual({ ok: false, problem: 'hash_mismatch', seq: 3 })

        const backdated = rows.map((row) => (row.seq === 4 ? { ...row, occurredAt: new Date(T0 - 86_400_000) } : row))
        expect(verifyCashAccessChainV1(backdated)).toEqual({ ok: false, problem: 'hash_mismatch', seq: 4 })

        // A forged row rehashed by itself still breaks the link to the next one.
        const forgedRow = { ...rows[1], payload: { forged: true } }
        const forged = rows.map((row) => (row.seq === 2 ? { ...forgedRow, hash: cashAccessEventHashV1({ ...forgedRow, hash: undefined } as never) } : row))
        expect(verifyCashAccessChainV1(forged)).toEqual({ ok: false, problem: 'prev_hash_mismatch', seq: 3 })

        expect(verifyCashAccessChainV1(rows.filter((row) => row.seq !== 2))).toEqual({ ok: false, problem: 'seq_gap', seq: 3 })
        const resequenced = rows.map((row) => (row.seq === 3 ? { ...row, seq: 4 } : row.seq === 4 ? { ...row, seq: 3 } : row))
        expect(verifyCashAccessChainV1(resequenced).ok).toBe(false)
        expect(verifyCashAccessChainV1([...rows, { ...rows[0], chainContactId: 'contact-2', seq: 5 }])).toMatchObject({ ok: false, problem: 'chain_mixed' })
    })

    it('finds a manager kind written by the system, or a system kind written by a manager, even when hashed correctly', () => {
        const forgedGrant = chain([{ kind: 'manual_granted', actorKind: 'system', actorId: 'system:fleet', actorCapability: null, reason: null }])
        expect(verifyCashAccessChainV1(forgedGrant)).toEqual({ ok: false, problem: 'writer_not_allowed', seq: 1 })
        const staffGrant = chain([{ kind: 'referral_entitlement_granted', ...staff(CASH_ACCESS_MANAGE_CAPABILITY_V1) }])
        expect(verifyCashAccessChainV1(staffGrant)).toEqual({ ok: false, problem: 'writer_not_allowed', seq: 1 })
    })
})

describe('who may write each kind', () => {
    it('admits system kinds only from the system and manager kinds only from a signed session with the capability and a reason', () => {
        for (const kind of CASH_ACCESS_EVENT_KINDS_V1) {
            const writer = CASH_ACCESS_EVENT_WRITER_V1[kind]
            const system = { kind, actorKind: 'system' as const, actorId: 'system:fleet', actorCapability: null, reason: null }
            const signed = (capability: string, reason: string | null = 'checked the park documents') => ({
                kind, actorKind: 'signed_staff_session' as const, actorId: 'staff:m1', actorCapability: capability, reason,
            })
            if (writer.actorKind === 'system') {
                expect(cashAccessWriterAllowedV1(system), kind).toBe(true)
                expect(cashAccessWriterAllowedV1(signed(CASH_ACCESS_MANAGE_CAPABILITY_V1)), kind).toBe(false)
            } else {
                expect(cashAccessWriterAllowedV1(system), kind).toBe(false)
                expect(cashAccessWriterAllowedV1(signed(writer.capability)), kind).toBe(true)
                expect(cashAccessWriterAllowedV1(signed('cash.access.view')), kind).toBe(false)
                expect(cashAccessWriterAllowedV1(signed(writer.capability, null)), kind).toBe(false)
                expect(cashAccessWriterAllowedV1(signed(writer.capability, 'too short')), kind).toBe(false)
                expect(cashAccessWriterAllowedV1({ ...signed(writer.capability), actorId: '  ' }), kind).toBe(false)
            }
        }
        expect(CASH_ACCESS_EVENT_WRITER_V1.referral_sanctioned).toEqual({ actorKind: 'signed_staff_session', capability: CASH_REFERRAL_QUALIFY_CAPABILITY_V1 })
    })
})

describe('the access fold', () => {
    it('gives a referral entitlement from the grant row\'s own database time, ended by a revoke', () => {
        const granted = chain([{ kind: 'referral_entitlement_granted', attributionId: 'attr-1' }])
        expect(foldCashAccessLedgerV1(granted, LINEAGE)).toEqual({
            referral: { confirmedAt: new Date(T0), revokedAt: null },
            manual: null,
            staleLineage: false,
        })
        const revoked = chain([
            { kind: 'referral_entitlement_granted', attributionId: 'attr-1' },
            { kind: 'referral_entitlement_revoked', attributionId: 'attr-1' },
        ])
        expect(foldCashAccessLedgerV1(revoked, LINEAGE).referral).toEqual({ confirmedAt: new Date(T0), revokedAt: new Date(T0 + 3_600_000) })
        // A later qualification grants again, from its own instant.
        const regranted = chain([
            { kind: 'referral_entitlement_granted', attributionId: 'attr-1' },
            { kind: 'referral_entitlement_revoked', attributionId: 'attr-1' },
            { kind: 'referral_entitlement_granted', attributionId: 'attr-2' },
        ])
        expect(foldCashAccessLedgerV1(regranted, LINEAGE).referral).toEqual({ confirmedAt: new Date(T0 + 7_200_000), revokedAt: null })
    })

    it('keeps the latest standing manual decision; a clear removes it; a revoke of the referral leaves it alone', () => {
        const rows = chain([
            { kind: 'manual_granted' },
            { kind: 'referral_entitlement_granted', attributionId: 'attr-1' },
            { kind: 'manual_denied' },
            { kind: 'referral_entitlement_revoked', attributionId: 'attr-1' },
        ])
        const fold = foldCashAccessLedgerV1(rows, LINEAGE)
        expect(fold.manual).toMatchObject({ decision: 'deny', decidedAt: new Date(T0 + 7_200_000), actor: { kind: 'signed_staff_session', principalId: 'staff:manager-1' } })
        expect(fold.referral).toEqual({ confirmedAt: new Date(T0 + 3_600_000), revokedAt: new Date(T0 + 3 * 3_600_000) })
        const cleared = chain([{ kind: 'manual_granted' }, { kind: 'manual_cleared' }])
        expect(foldCashAccessLedgerV1(cleared, LINEAGE).manual).toBeNull()
    })

    it('never folds a row its kind\'s writer did not make', () => {
        const forged = chain([
            { kind: 'manual_granted', actorKind: 'system', actorId: 'system:fleet', actorCapability: null, reason: null },
            { kind: 'referral_entitlement_granted', ...staff(CASH_ACCESS_MANAGE_CAPABILITY_V1) },
        ])
        expect(foldCashAccessLedgerV1(forged, LINEAGE)).toEqual({ referral: null, manual: null, staleLineage: false })
    })

    it('carries nothing across a merge and says the person needs a look', () => {
        const before = chain([{ kind: 'referral_entitlement_granted', attributionId: 'attr-1', lineageDigest: 'lineage:before' }])
        expect(foldCashAccessLedgerV1(before, LINEAGE)).toEqual({ referral: null, manual: null, staleLineage: true })
        const regranted = chain([
            { kind: 'referral_entitlement_granted', attributionId: 'attr-1', lineageDigest: 'lineage:before' },
            { kind: 'manual_granted' },
        ])
        expect(foldCashAccessLedgerV1(regranted, LINEAGE)).toMatchObject({ referral: null, manual: { decision: 'grant' }, staleLineage: false })
    })

    it('feeds the access decision: a referral grant opens later months, a general deny closes everything', () => {
        const rows = chain([{ kind: 'referral_entitlement_granted', attributionId: 'attr-1' }])
        const fold = foldCashAccessLedgerV1(rows, LINEAGE)
        const access = decideCashAccessV1({
            identity: { proven: true },
            standardFacts: { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2024-01-10T06:00:00.000Z') },
            referral: fold.referral,
            manual: fold.manual,
            ownerPolicy: { manualDenyClosesStandardProgramme: true, referralOfferAfterManualDeny: false },
            at: new Date('2027-03-15T06:00:00.000Z'),
        })
        expect(access).toMatchObject({ access: 'granted', windows: [{ basis: 'referral', ordersFrom: new Date(T0), ordersUntil: null }] })

        const denied = foldCashAccessLedgerV1(chain([{ kind: 'referral_entitlement_granted', attributionId: 'attr-1' }, { kind: 'manual_denied' }]), LINEAGE)
        expect(decideCashAccessV1({
            identity: { proven: true },
            standardFacts: { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: new Date('2027-03-02T06:00:00.000Z') },
            referral: denied.referral,
            manual: denied.manual,
            ownerPolicy: { manualDenyClosesStandardProgramme: true, referralOfferAfterManualDeny: false },
            at: new Date('2027-03-15T06:00:00.000Z'),
        })).toMatchObject({ access: 'refused', reasons: ['manual_deny'], referralOffer: 'no_offer' })
    })
})

describe('sanctions and kept dismissal readings for one invitation', () => {
    it('reads the latest signed sanction for the invitation, ignoring other invitations', () => {
        const rows = chain([
            { kind: 'referral_sanctioned', attributionId: 'attr-other' },
            { kind: 'referral_sanctioned', attributionId: 'attr-1' },
        ])
        expect(latestCashReferralSanctionV1(rows, 'attr-1')).toEqual({
            attributionId: 'attr-1',
            sanctionedAt: new Date(T0 + 3_600_000),
            actor: { kind: 'signed_staff_session', principalId: 'staff:manager-1', capabilities: [CASH_REFERRAL_QUALIFY_CAPABILITY_V1] },
        })
        expect(latestCashReferralSanctionV1(rows, 'attr-none')).toBeNull()
    })

    it('keeps well-formed dismissal readings per profile and drops malformed ones', () => {
        const rows = chain([
            { kind: 'invitee_dismissal_observed', attributionId: 'attr-1', payload: { profileKey: 'park:p1', dismissedAt: '2026-07-11T12:00:00.000Z', readAt: '2026-11-05T19:00:00.000Z' } },
            { kind: 'invitee_dismissal_observed', attributionId: 'attr-1', payload: { profileKey: 'park:p1', dismissedAt: 'not a date', readAt: '2026-11-05T19:00:00.000Z' } },
            { kind: 'invitee_dismissal_observed', attributionId: 'attr-2', payload: { profileKey: 'park:p9', dismissedAt: '2026-07-11T12:00:00.000Z', readAt: '2026-11-05T19:00:00.000Z' } },
        ])
        const kept = keptCashReferralDismissalsV1(rows, 'attr-1')
        expect([...kept.keys()]).toEqual(['park:p1'])
        expect(kept.get('park:p1')).toEqual([{ dismissedAt: new Date('2026-07-11T12:00:00.000Z'), readAt: new Date('2026-11-05T19:00:00.000Z') }])
    })
})
