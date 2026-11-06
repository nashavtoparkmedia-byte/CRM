import { describe, expect, it } from 'vitest'

import { CASH_ACCESS_MANAGE_CAPABILITY_V1, decideCashAccessV1 } from './compensation-access'
import { CASH_REFERRAL_QUALIFY_CAPABILITY_V1 } from './compensation-referral-qualification'
import {
    cashAccessEventHashV1,
    foldCashAccessLedgerV1,
    verifyCashAccessChainV1,
    type CashAccessEventKindV1,
    type CashAccessEventV1,
} from './compensation-referral-ledger'
import {
    CASH_ACCESS_GRANT_CAPABILITY_V1,
    CASH_REFERRAL_LINK_CAPABILITY_V1,
    cashAccessManagerViewV1,
    cashReferralRequestIdValidV1,
    cashStaffAuthorityAdmitsV1,
    decideCashAccessGrantV1,
    decideCashAccessRevokeV1,
    decideCashReferralLinkV1,
    groupCashReferralCandidatesV1,
    parseCashReferralManagerQueryV1,
    type CashReferralInvitationRowV1,
    type CashReferralManagerProfileV1,
} from './cash-referral-manager'

/**
 * The manager's referral rules, pure.
 *
 * What has to hold: recording an invitation never changes access; a grant
 * needs no invitation; nobody invites themselves; one invitee counts for one
 * inviter; a grant that stands is not written twice; and nothing is written
 * without a signed staff session holding the capability.
 */

const AT = new Date('2026-11-06T12:00:00.000Z')
const LINEAGE = 'lineage:A'

function chain(kinds: Array<{
    kind: CashAccessEventKindV1
    payload?: Record<string, string | null>
    lineageDigest?: string
    attributionId?: string | null
    staff?: boolean
    capability?: string
}>): CashAccessEventV1[] {
    const events: CashAccessEventV1[] = []
    kinds.forEach((spec, index) => {
        const staff = spec.staff ?? true
        const unhashed: Omit<CashAccessEventV1, 'hash'> = {
            id: `e${index + 1}`,
            chainContactId: 'contact-A',
            seq: index + 1,
            kind: spec.kind,
            lineageDigest: spec.lineageDigest ?? LINEAGE,
            codeHash: spec.kind === 'referral_code_issued' ? 'a'.repeat(64) : null,
            attributionId: spec.attributionId ?? null,
            payload: spec.payload ?? {},
            actorKind: staff ? 'signed_staff_session' : 'system',
            actorId: staff ? 'staff:1' : 'system:cash-referral',
            actorCapability: staff ? spec.capability ?? 'cash.access.manage' : null,
            actorSessionId: staff ? 'session-1' : null,
            actorAuthenticatedAt: staff ? new Date('2026-11-06T08:00:00.000Z') : null,
            reason: staff ? 'Реферальная программа' : null,
            idempotencyKey: `key-${index + 1}`,
            occurredAt: new Date(AT.getTime() - (kinds.length - index) * 60_000),
            prevHash: index === 0 ? null : events[index - 1].hash,
        }
        events.push({ ...unhashed, hash: cashAccessEventHashV1(unhashed) })
    })
    return events
}

function profile(over: Partial<CashReferralManagerProfileV1>): CashReferralManagerProfileV1 {
    return {
        driverId: 'd1',
        fullName: 'Иванов Иван Иванович',
        phone: '+7 922 185-31-50',
        licenseNumber: '99 12 345678',
        externalParkId: 'park-1',
        parkName: 'Парк 1',
        employmentType: 'selfemployed',
        isSelfEmployed: true,
        dismissed: false,
        contactId: 'contact-A',
        ...over,
    }
}

function invitation(over: Partial<CashReferralInvitationRowV1>): CashReferralInvitationRowV1 {
    return {
        attributionId: 'att-1',
        source: 'manager',
        state: 'recorded',
        inviterContactId: 'contact-A',
        inviteeContactId: 'contact-B',
        capturedAt: AT,
        decidedAt: AT,
        version: 0,
        ...over,
    }
}

describe('search query', () => {
    it('reads a name, a phone and a licence, and refuses a query that names nobody', () => {
        expect(parseCashReferralManagerQueryV1('Иванов  Иван')).toEqual({ ok: true, query: { nameTokens: ['иванов', 'иван'], phoneDigits: null, licence: null } })
        expect(parseCashReferralManagerQueryV1('+7 (922) 185-31-50')).toEqual({ ok: true, query: { nameTokens: [], phoneDigits: '9221853150', licence: '79221853150' } })
        // Ten digits are tried as a phone and as a licence alike.
        expect(parseCashReferralManagerQueryV1('9912 345678')).toEqual({ ok: true, query: { nameTokens: [], phoneDigits: '9912345678', licence: '9912345678' } })
        expect(parseCashReferralManagerQueryV1('77 АВ 123456')).toMatchObject({ ok: true, query: { licence: '77АВ123456' } })
        // Initials drop out instead of fusing into a word, and a phone beside a name still counts.
        expect(parseCashReferralManagerQueryV1('Иванов И.И.')).toEqual({ ok: true, query: { nameTokens: ['иванов'], phoneDigits: null, licence: null } })
        expect(parseCashReferralManagerQueryV1('Иванов 922 185 31 50')).toMatchObject({ ok: true, query: { nameTokens: ['иванов'], phoneDigits: '9221853150' } })
        expect(parseCashReferralManagerQueryV1('И')).toEqual({ ok: false, refusal: 'query_too_short' })
        expect(parseCashReferralManagerQueryV1('12')).toEqual({ ok: false, refusal: 'query_too_short' })
        expect(parseCashReferralManagerQueryV1('я'.repeat(101))).toEqual({ ok: false, refusal: 'query_too_long' })
        expect(parseCashReferralManagerQueryV1(undefined)).toEqual({ ok: false, refusal: 'query_too_short' })
    })
})

describe('people from search hits', () => {
    it('groups the profiles of one person across parks and lists every profile of that person', () => {
        const hit = profile({ driverId: 'd1', contactId: 'contact-A' })
        const other = profile({ driverId: 'd2', contactId: 'contact-A2', parkName: 'Парк 2', dismissed: true })
        const candidates = groupCashReferralCandidatesV1(
            [{ profile: hit, matchedBy: ['name'] }],
            new Map([['contact-A', { status: 'resolved' as const, canonicalContactId: 'contact-A', contactIds: ['contact-A', 'contact-A2'] }]]),
            new Map([['contact-A', [hit, other]]]),
        )
        expect(candidates).toHaveLength(1)
        expect(candidates[0]).toMatchObject({ selectable: true, personContactId: 'contact-A', lineage: ['contact-A', 'contact-A2'] })
        expect(candidates[0].profiles.map((p) => p.driverId)).toEqual(['d1', 'd2'])
    })

    it('keeps two people of the same name apart, and never offers a profile without a person', () => {
        const first = profile({ driverId: 'd1', contactId: 'contact-A' })
        const second = profile({ driverId: 'd2', contactId: 'contact-B', phone: '+79990000000' })
        const orphan = profile({ driverId: 'd3', contactId: null })
        const unresolved = profile({ driverId: 'd4', contactId: 'contact-X' })
        const candidates = groupCashReferralCandidatesV1(
            [first, second, orphan, unresolved].map((p) => ({ profile: p, matchedBy: ['name' as const] })),
            new Map([
                ['contact-A', { status: 'resolved' as const, canonicalContactId: 'contact-A', contactIds: ['contact-A'] }],
                ['contact-B', { status: 'resolved' as const, canonicalContactId: 'contact-B', contactIds: ['contact-B'] }],
                ['contact-X', { status: 'unresolvable' as const }],
            ]),
            new Map(),
        )
        expect(candidates.filter((c) => c.selectable).map((c) => c.selectable && c.personContactId)).toEqual(['contact-A', 'contact-B'])
        expect(candidates.filter((c) => !c.selectable).map((c) => !c.selectable && c.reason)).toEqual(['no_contact', 'contact_unresolved'])
    })
})

describe('recording an invitation', () => {
    const inviter = { contactId: 'contact-A', lineage: ['contact-A'], licenceKeys: ['9912345678'] }
    const invitee = { contactId: 'contact-B', lineage: ['contact-B'], licenceKeys: ['9900111111'] }

    it('records an invitee nobody counts yet', () => {
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [] })).toEqual({ outcome: 'record' })
        // A Telegram invitation that is not counted does not hold the invitee.
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [invitation({ source: 'telegram', state: 'pending', inviterContactId: 'contact-C' })] }))
            .toEqual({ outcome: 'record' })
        // Nor does a withdrawn record.
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [invitation({ state: 'withdrawn', inviterContactId: 'contact-C' })] }))
            .toEqual({ outcome: 'record' })
    })

    it('refuses one person as their own invitee, by contact lineage or by licence', () => {
        expect(decideCashReferralLinkV1({ inviter, invitee: { ...invitee, contactId: 'contact-A', lineage: ['contact-A'] }, inviteeInvitations: [] }))
            .toEqual({ outcome: 'refused', reason: 'self_invitation' })
        expect(decideCashReferralLinkV1({ inviter: { ...inviter, lineage: ['contact-A', 'contact-B'] }, invitee, inviteeInvitations: [] }))
            .toEqual({ outcome: 'refused', reason: 'self_invitation' })
        expect(decideCashReferralLinkV1({ inviter, invitee: { ...invitee, licenceKeys: ['9912345678'] }, inviteeInvitations: [] }))
            .toEqual({ outcome: 'refused', reason: 'self_invitation' })
    })

    it('answers a repeat with the record that stands, and keeps an invitee with the inviter who has them', () => {
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [invitation({ attributionId: 'att-9' })] }))
            .toEqual({ outcome: 'already_recorded', attributionId: 'att-9' })
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [invitation({ attributionId: 'att-7', inviterContactId: 'contact-C' })] }))
            .toEqual({ outcome: 'refused', reason: 'invitee_already_attributed', attributionId: 'att-7', inviterContactId: 'contact-C' })
        // A Telegram invitation that qualified counts the same as a manager's record.
        expect(decideCashReferralLinkV1({ inviter, invitee, inviteeInvitations: [invitation({ source: 'telegram', state: 'qualified', inviterContactId: 'contact-C' })] }))
            .toMatchObject({ outcome: 'refused', reason: 'invitee_already_attributed' })
    })
})

describe('access as the manager sees it', () => {
    it('recording or withdrawing an invitation grants nothing', () => {
        const events = chain([
            { kind: 'referral_link_recorded', payload: { invitationId: 'inv-1' }, capability: 'cash.referral.qualify' },
            { kind: 'referral_link_withdrawn', payload: { invitationId: 'inv-1' }, capability: 'cash.referral.qualify' },
            { kind: 'referral_link_recorded', payload: { invitationId: 'inv-2' }, capability: 'cash.referral.qualify' },
        ])
        expect(verifyCashAccessChainV1(events)).toEqual({ ok: true, length: 3 })
        expect(foldCashAccessLedgerV1(events, LINEAGE)).toEqual({ referral: null, manual: null, staleLineage: false })
        expect(cashAccessManagerViewV1(events, LINEAGE)).toMatchObject({ state: 'none', manualGrant: null, history: [] })
    })

    it('shows a standing grant with its basis and the invitation it names, the way Cash reads it', () => {
        const events = chain([
            { kind: 'referral_link_recorded', payload: { invitationId: 'att-1' }, capability: 'cash.referral.qualify' },
            { kind: 'manual_granted', payload: { basis: 'referral_program', referralAttributionId: 'att-1', operatorLabel: 'Мария Иванова' } },
        ])
        const view = cashAccessManagerViewV1(events, LINEAGE)
        expect(view.state).toBe('granted')
        expect(view.manualGrant).toMatchObject({ basis: 'referral_program', referralAttributionId: 'att-1', operatorLabel: 'Мария Иванова' })
        expect(view.history).toHaveLength(1)
        // The Cash access decision opens a manual window on the same events.
        const fold = foldCashAccessLedgerV1(events, LINEAGE)
        const decision = decideCashAccessV1({ identity: { proven: true }, standardFacts: null, referral: fold.referral, manual: fold.manual, ownerPolicy: {}, at: AT })
        expect(decision).toMatchObject({ access: 'granted', windows: [{ basis: 'manual_grant', ordersUntil: null }] })
    })

    it('shows a cleared grant as none, a denial as denied, and access from before a merge as needing review', () => {
        expect(cashAccessManagerViewV1(chain([{ kind: 'manual_granted' }, { kind: 'manual_cleared' }]), LINEAGE).state).toBe('none')
        expect(cashAccessManagerViewV1(chain([{ kind: 'manual_denied' }]), LINEAGE).state).toBe('denied')
        const stale = cashAccessManagerViewV1(chain([{ kind: 'manual_granted', lineageDigest: 'lineage:old' }]), LINEAGE)
        expect(stale.state).toBe('needs_review')
        expect(stale.history[0].stale).toBe(true)
    })
})

describe('granting and revoking', () => {
    const base = { lineage: ['contact-A'], referralAttributionId: null, personInvitations: [], comment: null, operatorLabel: 'Мария' }
    const none = cashAccessManagerViewV1([], LINEAGE)
    const granted = cashAccessManagerViewV1(chain([{ kind: 'manual_granted', payload: { basis: 'manager_decision' } }]), LINEAGE)

    it('grants without any invitation, and does not write a grant that stands', () => {
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'referral_program' }))
            .toEqual({ outcome: 'grant', reason: 'Реферальная программа', payload: { basis: 'referral_program', referralAttributionId: null, operatorLabel: 'Мария' } })
        expect(decideCashAccessGrantV1({ ...base, view: granted, basis: 'referral_program' })).toEqual({ outcome: 'already_granted' })
    })

    it('names only one of the person\'s own counted invitations', () => {
        const own = invitation({ attributionId: 'att-1' })
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'referral_program', referralAttributionId: 'att-1', personInvitations: [own] }))
            .toMatchObject({ outcome: 'grant', payload: { referralAttributionId: 'att-1' } })
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'referral_program', referralAttributionId: 'att-1', personInvitations: [invitation({ inviterContactId: 'contact-C' })] }))
            .toEqual({ outcome: 'refused', reason: 'invitation_not_found' })
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'referral_program', referralAttributionId: 'att-1', personInvitations: [invitation({ state: 'withdrawn' })] }))
            .toEqual({ outcome: 'refused', reason: 'invitation_not_found' })
    })

    it('needs the manager\'s words for another decision, and refuses a person Cash would not bind', () => {
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'manager_decision', comment: 'коротко' }))
            .toEqual({ outcome: 'refused', reason: 'comment_required' })
        expect(decideCashAccessGrantV1({ ...base, view: none, basis: 'manager_decision', comment: 'Водитель-наставник парка' }))
            .toMatchObject({ outcome: 'grant', reason: 'Решение менеджера: Водитель-наставник парка' })
        expect(decideCashAccessGrantV1({ ...base, lineage: ['contact-A', 'contact-A2'], view: none, basis: 'referral_program' }))
            .toEqual({ outcome: 'refused', reason: 'person_merged' })
    })

    it('revokes every standing grant and leaves a denial and the standard programme alone', () => {
        expect(decideCashAccessRevokeV1({ view: none, comment: null, operatorLabel: 'Мария' })).toEqual({ outcome: 'nothing_to_revoke' })
        expect(decideCashAccessRevokeV1({ view: granted, comment: null, operatorLabel: 'Мария' }))
            .toMatchObject({ outcome: 'revoke', clearManual: true, revokeEntitlementOf: null, reason: 'Доступ отозван менеджером' })
        const entitled = cashAccessManagerViewV1(chain([{ kind: 'referral_entitlement_granted', attributionId: 'att-5', staff: false }]), LINEAGE)
        expect(decideCashAccessRevokeV1({ view: entitled, comment: 'ошибка', operatorLabel: 'Мария' }))
            .toMatchObject({ outcome: 'revoke', clearManual: false, revokeEntitlementOf: 'att-5', reason: 'Доступ отозван менеджером: ошибка' })
        const denied = cashAccessManagerViewV1(chain([{ kind: 'manual_denied' }]), LINEAGE)
        expect(decideCashAccessRevokeV1({ view: denied, comment: null, operatorLabel: 'Мария' })).toEqual({ outcome: 'nothing_to_revoke' })
    })
})

describe('who may write', () => {
    const authority = {
        principalId: 'staff:1',
        operatorLabel: 'Мария',
        sessionId: 'session-1',
        authenticatedAt: new Date('2026-11-06T08:00:00.000Z'),
        capabilities: ['cash.access.manage'],
    }

    it('admits only a signed staff session that holds the capability', () => {
        expect(cashStaffAuthorityAdmitsV1(authority, 'cash.access.manage', AT)).toEqual({ admitted: true })
        expect(cashStaffAuthorityAdmitsV1(authority, 'cash.referral.qualify', AT)).toEqual({ admitted: false, refusal: 'capability_missing' })
        expect(cashStaffAuthorityAdmitsV1({ ...authority, sessionId: ' ' }, 'cash.access.manage', AT)).toEqual({ admitted: false, refusal: 'staff_session_invalid' })
        expect(cashStaffAuthorityAdmitsV1({ ...authority, principalId: '' }, 'cash.access.manage', AT)).toEqual({ admitted: false, refusal: 'staff_session_invalid' })
        expect(cashStaffAuthorityAdmitsV1({ ...authority, authenticatedAt: new Date('2026-11-07T00:00:00.000Z') }, 'cash.access.manage', AT))
            .toEqual({ admitted: false, refusal: 'staff_session_invalid' })
    })

    it('asks for exactly the capabilities the ledger writer table and the database admit', () => {
        expect(CASH_REFERRAL_LINK_CAPABILITY_V1).toBe(CASH_REFERRAL_QUALIFY_CAPABILITY_V1)
        expect(CASH_ACCESS_GRANT_CAPABILITY_V1).toBe(CASH_ACCESS_MANAGE_CAPABILITY_V1)
    })

    it('accepts only a well-formed request id', () => {
        expect(cashReferralRequestIdValidV1('8f14e45f-ceea-467a-9575-3f1c0b5e6a11')).toBe(true)
        expect(cashReferralRequestIdValidV1('retry')).toBe(false)
        expect(cashReferralRequestIdValidV1(undefined)).toBe(false)
    })
})
