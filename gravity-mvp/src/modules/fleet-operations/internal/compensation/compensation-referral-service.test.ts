import { describe, expect, it, vi } from 'vitest'

import { compensationLineageDigestV1 } from './compensation-pilot-lineage'
import { cashReferralPersonKeyDigestV1, type CashAccessEventV1 } from './compensation-referral-ledger'
import {
    runCashReferralDecisionPassV1,
    type CashReferralAttributionV1,
    type CashReferralDecisionPortV1,
    type CashReferralFleetProfileV1,
    type CashReferralInviteeFleetFactsV1,
} from './compensation-referral-service'

// Business calendar is Asia/Yekaterinburg (UTC+5).
const CAPTURED_AT = new Date('2026-11-02T08:00:00.000Z')
const NOW = new Date('2026-11-20T06:00:00.000Z')
const INVITER = 'contact-inviter'
const INVITEE = 'contact-invitee'

const attribution = (overrides: Partial<CashReferralAttributionV1> = {}): CashReferralAttributionV1 => ({
    id: 'attr-1',
    inviterContactId: INVITER,
    inviterLineageDigest: compensationLineageDigestV1([INVITER]),
    inviteeTelegramUserId: '2002',
    inviteeDriverId: 'driver-invitee',
    state: 'captured',
    reason: null,
    capturedAt: CAPTURED_AT,
    version: 0,
    ...overrides,
})

const profile = (id: string, registeredAt: string | null): CashReferralFleetProfileV1 => ({
    profileRef: `park-1:${id}`,
    externalParkId: 'park-1',
    externalDriverProfileId: id,
    registeredAt: registeredAt === null ? null : new Date(registeredAt),
})

const fleet = (overrides: Partial<CashReferralInviteeFleetFactsV1> = {}): CashReferralInviteeFleetFactsV1 => ({
    proven: profile('new', '2026-11-05T06:00:00.000Z'),
    isSelfEmployed: true,
    workStatus: 'working',
    externalPersonKey: 'vu:7700123456',
    earlierProfiles: [],
    ...overrides,
})

function port(overrides: Partial<CashReferralDecisionPortV1> = {}, rows: CashReferralAttributionV1[] = [attribution()]): CashReferralDecisionPortV1 {
    return {
        findUndecided: vi.fn(async () => rows),
        readChain: vi.fn(async () => []),
        readAttributionEvents: vi.fn(async () => []),
        personAlreadyQualified: vi.fn(async () => false),
        writeDecision: vi.fn(async () => 'written' as const),
        resolveContactLineage: vi.fn(async (contactId: string) => ({ status: 'resolved' as const, canonicalContactId: contactId, contactIds: [contactId] })),
        findDriverContact: vi.fn(async () => ({ contactId: INVITEE })),
        confirmMainDriver: vi.fn(async () => 'confirmed' as const),
        readInviteeFleetFacts: vi.fn(async () => fleet()),
        personKeysOfContact: vi.fn(async () => ['vu:inviter']),
        contactsSharePhone: vi.fn(async () => false),
        readYandexProfile: vi.fn(async () => null),
        now: vi.fn(async () => NOW),
        ...overrides,
    }
}

const written = (p: CashReferralDecisionPortV1) => (p.writeDecision as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[0])

describe('a pass decides captured invitations', () => {
    it('qualifies a new park-SMZ and grants the inviter in the same write, keeping only a digest of the person key', async () => {
        const p = port()
        expect(await runCashReferralDecisionPassV1(p, 50)).toMatchObject({ examined: 1, written: 1, states: { qualified: 1 } })
        const [write] = written(p)
        expect(write).toMatchObject({
            attributionId: 'attr-1',
            expectedVersion: 0,
            state: 'qualified',
            reason: 'new_park_smz',
            grant: true,
            inviteeContactId: INVITEE,
            inviteePersonKey: cashReferralPersonKeyDigestV1('vu:7700123456'),
            targetParkId: 'park-1',
            idempotencyKey: 'decision:attr-1:0',
        })
        expect(JSON.stringify(write)).not.toContain('7700123456')
        expect(p.readYandexProfile).not.toHaveBeenCalled()
    })

    it('qualifies a returned driver on a read made now that shows the earlier profile fired before the capture, and keeps the reading', async () => {
        const p = port({
            readInviteeFleetFacts: vi.fn(async () => fleet({ earlierProfiles: [profile('old', '2024-03-01T06:00:00.000Z')] })),
            readYandexProfile: vi.fn(async () => ({ workStatus: 'fired', fireDate: '2026-07-10', readAt: NOW })),
        })
        await runCashReferralDecisionPassV1(p, 50)
        const [write] = written(p)
        expect(write).toMatchObject({ state: 'qualified', reason: 'returned_park_smz', grant: true })
        expect(write.observedDismissals).toEqual([{ profileKey: 'park-1:old', dismissedAt: new Date('2026-07-11T12:00:00.000Z'), readAt: NOW }])
        expect(p.readYandexProfile).toHaveBeenCalledTimes(1)
    })

    it('holds the invitation pending when the read was skipped or failed, never sending it to review', async () => {
        const p = port({ readInviteeFleetFacts: vi.fn(async () => fleet({ earlierProfiles: [profile('old', '2024-03-01T06:00:00.000Z')] })) })
        await runCashReferralDecisionPassV1(p, 50)
        expect(written(p)[0]).toMatchObject({ state: 'pending', reason: 'invitee_departure_unknown', grant: false })
    })

    it('sends a profile read connected after the capture, or dismissed only after it, to a manager', async () => {
        for (const read of [{ workStatus: 'working', fireDate: null }, { workStatus: 'fired', fireDate: '2026-11-04' }]) {
            const p = port({
                readInviteeFleetFacts: vi.fn(async () => fleet({ earlierProfiles: [profile('old', '2024-03-01T06:00:00.000Z')] })),
                readYandexProfile: vi.fn(async () => ({ ...read, readAt: NOW })),
            })
            await runCashReferralDecisionPassV1(p, 50)
            expect(written(p)[0]).toMatchObject({ state: 'needs_review', reason: 'invitee_departure_unproven', grant: false })
        }
    })

    it('reads the fleet work status, so a fired invitee is not connected whatever their hire date', async () => {
        const p = port({ readInviteeFleetFacts: vi.fn(async () => fleet({ workStatus: 'fired' })) })
        await runCashReferralDecisionPassV1(p, 50)
        expect(written(p)[0]).toMatchObject({ state: 'not_qualified', reason: 'invitee_not_connected' })
        const unknown = port({ readInviteeFleetFacts: vi.fn(async () => fleet({ workStatus: null })) })
        await runCashReferralDecisionPassV1(unknown, 50)
        expect(written(unknown)[0]).toMatchObject({ state: 'pending', reason: 'invitee_facts_unavailable' })
    })

    it('sends a shared phone to a manager', async () => {
        const p = port({ contactsSharePhone: vi.fn(async () => true) })
        await runCashReferralDecisionPassV1(p, 50)
        expect(written(p)[0]).toMatchObject({ state: 'needs_review', reason: 'invitee_shares_phone', grant: false })
    })

    it('rejects a self-referral by person key, a person another invitation qualified, and grants no second time', async () => {
        const self = port({ personKeysOfContact: vi.fn(async () => ['vu:7700123456']) })
        await runCashReferralDecisionPassV1(self, 50)
        expect(written(self)[0]).toMatchObject({ state: 'rejected', reason: 'self_referral' })

        const duplicate = port({ personAlreadyQualified: vi.fn(async () => true) })
        await runCashReferralDecisionPassV1(duplicate, 50)
        expect(written(duplicate)[0]).toMatchObject({ state: 'rejected', reason: 'invitee_already_attributed' })

        const grant: CashAccessEventV1 = {
            id: 'row-1', chainContactId: INVITER, seq: 1, kind: 'referral_entitlement_granted', lineageDigest: compensationLineageDigestV1([INVITER]),
            codeHash: null, attributionId: 'attr-0', payload: {}, actorKind: 'system', actorId: 'system:cash-referral', actorCapability: null,
            actorSessionId: null, actorAuthenticatedAt: null, reason: null, idempotencyKey: 'grant:attr-0',
            occurredAt: new Date('2026-10-01T00:00:00.000Z'), prevHash: null, hash: 'a'.repeat(64),
        }
        const entitled = port({ readChain: vi.fn(async () => [grant]) })
        await runCashReferralDecisionPassV1(entitled, 50)
        expect(written(entitled)[0]).toMatchObject({ state: 'qualified', grant: false, decision: { grant: 'already_entitled' } })
    })

    it('holds the invitation while either person is not proven', async () => {
        const merged = port({
            resolveContactLineage: vi.fn(async (contactId: string) => contactId === INVITER
                ? { status: 'resolved' as const, canonicalContactId: 'contact-survivor', contactIds: ['contact-survivor', INVITER] }
                : { status: 'resolved' as const, canonicalContactId: contactId, contactIds: [contactId] }),
        })
        await runCashReferralDecisionPassV1(merged, 50)
        expect(written(merged)[0]).toMatchObject({ state: 'pending', reason: 'inviter_identity_blocked' })

        const notLinked = port({}, [attribution({ inviteeDriverId: null })])
        await runCashReferralDecisionPassV1(notLinked, 50)
        expect(written(notLinked)[0]).toMatchObject({ state: 'pending', reason: 'invitee_not_linked' })
        expect(notLinked.findDriverContact).not.toHaveBeenCalled()
        const noContact = port({ findDriverContact: vi.fn(async () => ({ contactId: null })) })
        await runCashReferralDecisionPassV1(noContact, 50)
        expect(written(noContact)[0]).toMatchObject({ state: 'pending', reason: 'invitee_not_linked' })

        const unconfirmed = port({ confirmMainDriver: vi.fn(async () => 'not_confirmed' as const) })
        await runCashReferralDecisionPassV1(unconfirmed, 50)
        expect(written(unconfirmed)[0]).toMatchObject({ state: 'pending', reason: 'invitee_identity_blocked' })
    })

    it('writes nothing when nothing changed, and counts a raced write as a conflict', async () => {
        const unchanged = port({}, [attribution({ inviteeDriverId: null, state: 'pending', reason: 'invitee_not_linked', version: 3 })])
        expect(await runCashReferralDecisionPassV1(unchanged, 50)).toMatchObject({ examined: 1, written: 0, unchanged: 1 })
        expect(unchanged.writeDecision).not.toHaveBeenCalled()

        const raced = port({ writeDecision: vi.fn(async () => 'version_conflict' as const) })
        expect(await runCashReferralDecisionPassV1(raced, 50)).toMatchObject({ written: 0, conflicts: 1 })
    })

    it('never qualifies without a person key to bind the one qualification to', async () => {
        const p = port({ readInviteeFleetFacts: vi.fn(async () => fleet({ externalPersonKey: null })) })
        await runCashReferralDecisionPassV1(p, 50)
        expect(written(p)[0]).toMatchObject({ state: 'pending', reason: 'invitee_facts_unavailable', grant: false })
    })
})
