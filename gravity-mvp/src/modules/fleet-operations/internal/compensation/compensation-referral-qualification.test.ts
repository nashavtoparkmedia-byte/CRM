import { describe, expect, it } from 'vitest'

import { CASH_ACCESS_IDENTITY_REFUSALS_V1, decideCashAccessV1, type CashAccessActorV1 } from './compensation-access'
import {
    CASH_REFERRAL_QUALIFY_CAPABILITY_V1,
    decideCashReferralQualificationV1,
    type CashReferralInviteeFactsV1,
    type CashReferralQualificationInputV1,
    type CashReferralSanctionV1,
} from './compensation-referral-qualification'

// Business calendar is Asia/Yekaterinburg (UTC+5).
const CAPTURED_AT = new Date('2026-11-02T08:00:00.000Z') // 2 November, 13:00 local
const AT = new Date('2026-11-20T06:00:00.000Z')

const signedQualifier: CashAccessActorV1 = {
    kind: 'signed_staff_session',
    principalId: 'staff:manager-1',
    capabilities: [CASH_REFERRAL_QUALIFY_CAPABILITY_V1],
}

function inviteeFacts(overrides: Partial<CashReferralInviteeFactsV1> = {}): CashReferralInviteeFactsV1 {
    return {
        isSelfEmployed: true,
        parkHireDate: new Date('2026-11-05T06:00:00.000Z'),
        dismissedAt: null,
        otherProfileRegisteredBeforeCapture: false,
        ...overrides,
    }
}

function qualification(overrides: Partial<CashReferralQualificationInputV1> = {}): CashReferralQualificationInputV1 {
    return {
        capture: {
            attributionId: 'attr-1',
            capturedAt: CAPTURED_AT,
            inviterContactId: 'contact-inviter',
            inviterTelegramUserId: '1001',
            inviteeTelegramUserId: '2002',
        },
        inviter: { proven: true, contactId: 'contact-inviter', lineage: ['contact-inviter'], externalPersonKey: 'vu:inviter' },
        invitee: { proven: true, contactId: 'contact-invitee', lineage: ['contact-invitee'], externalPersonKey: 'vu:invitee' },
        inviteeFacts: inviteeFacts(),
        sharedPhone: false,
        inviteeAlreadyAttributed: false,
        inviterAlreadyEntitled: false,
        sanction: null,
        at: AT,
        ...overrides,
    }
}

function sanction(overrides: Partial<CashReferralSanctionV1> = {}): CashReferralSanctionV1 {
    return { attributionId: 'attr-1', sanctionedAt: new Date('2026-11-19T10:00:00.000Z'), actor: signedQualifier, ...overrides }
}

const previouslyRegistered = inviteeFacts({ parkHireDate: new Date('2025-06-01T06:00:00.000Z') })

describe('a new park-SMZ invitee qualifies the inviter', () => {
    it('confirms referral access at the instant of the decision, never earlier', () => {
        expect(decideCashReferralQualificationV1(qualification())).toEqual({
            outcome: 'qualified',
            via: 'new_park_smz',
            grant: 'grant',
            confirmedAt: AT,
            ignored: [],
        })
    })

    it('gives an old non-SMZ inviter indefinite access from that instant', () => {
        const decided = decideCashReferralQualificationV1(qualification())
        if (decided.outcome !== 'qualified') throw new Error('expected a qualified invitation')
        const oldNonSmz = { isSelfEmployed: false, employmentType: 'park_employee', parkHireDate: new Date('2024-02-01T06:00:00.000Z') }
        const access = decideCashAccessV1({
            identity: { proven: true },
            standardFacts: oldNonSmz,
            referral: { confirmedAt: decided.confirmedAt, revokedAt: null },
            manual: null,
            ownerPolicy: {},
            at: new Date('2027-06-01T06:00:00.000Z'),
        })
        expect(access).toMatchObject({ access: 'granted', windows: [{ basis: 'referral', ordersFrom: AT, ordersUntil: null }] })
    })

    it('counts a hire on the capture\'s own business day as new, and the day before as registered', () => {
        // 2 November local runs 2026-11-01T19:00Z to 2026-11-02T19:00Z.
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ parkHireDate: new Date('2026-11-01T19:00:00.000Z') }) })))
            .toMatchObject({ outcome: 'qualified', via: 'new_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ parkHireDate: new Date('2026-11-01T18:59:59.999Z') }) })))
            .toMatchObject({ outcome: 'requires_manager_qualification', reason: 'invitee_registered_before_invitation' })
    })

    it('never expires: an invitation captured years ago still qualifies', () => {
        const old = qualification({
            capture: { ...qualification().capture, capturedAt: new Date('2023-01-10T08:00:00.000Z') },
            inviteeFacts: inviteeFacts({ parkHireDate: new Date('2026-11-05T06:00:00.000Z') }),
        })
        expect(decideCashReferralQualificationV1(old)).toMatchObject({ outcome: 'qualified', via: 'new_park_smz' })
    })
})

describe('an invitee who is not a park-SMZ', () => {
    it('does not qualify while the park states they are not self-employed, and qualifies once they are', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ isSelfEmployed: false }) })))
            .toMatchObject({ outcome: 'not_qualified', reason: 'invitee_not_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ isSelfEmployed: true }) })))
            .toMatchObject({ outcome: 'qualified' })
    })

    it('does not qualify once dismissed from the park', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ dismissedAt: new Date('2026-11-15T00:00:00.000Z') }) })))
            .toMatchObject({ outcome: 'not_qualified', reason: 'invitee_not_connected' })
    })
})

describe('unknown provider facts never refuse', () => {
    it('leaves the invitation pending on every unknown', () => {
        const cases: Array<[CashReferralInviteeFactsV1 | null, string]> = [
            [null, 'invitee_facts_unavailable'],
            [inviteeFacts({ isSelfEmployed: null }), 'invitee_smz_unknown'],
            [inviteeFacts({ parkHireDate: null }), 'invitee_hire_date_unknown'],
            [inviteeFacts({ otherProfileRegisteredBeforeCapture: null }), 'invitee_registration_history_unknown'],
        ]
        for (const [facts, reason] of cases) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts }))).toEqual({ outcome: 'pending', reason, ignored: [] })
        }
    })
})

describe('a previously registered invitee needs a manager\'s sanction', () => {
    it('asks for it when the invitee joined before the invitation, here or in another park', () => {
        for (const facts of [previouslyRegistered, inviteeFacts({ otherProfileRegisteredBeforeCapture: true })]) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts }))).toEqual({
                outcome: 'requires_manager_qualification',
                reason: 'invitee_registered_before_invitation',
                ignored: [],
            })
        }
    })

    it('qualifies with a signed sanction for this invitation, from the decision instant', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: previouslyRegistered, sanction: sanction() }))).toEqual({
            outcome: 'qualified',
            via: 'manager_sanction',
            grant: 'grant',
            confirmedAt: AT,
            ignored: [],
        })
        // An unknown registration history is resolved by the same sanction.
        expect(decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({ otherProfileRegisteredBeforeCapture: null }),
            sanction: sanction(),
        }))).toMatchObject({ outcome: 'qualified', via: 'manager_sanction' })
    })

    it('ignores a sanction that is unsigned, lacks the capability, names another invitation or is not yet made', () => {
        const cases: Array<[CashReferralSanctionV1, string]> = [
            [sanction({ actor: { kind: 'crm_user', principalId: 'crm_user:u3' } }), 'sanction_unsigned'],
            [sanction({ actor: { kind: 'integration_admin', principalId: 'identity-access:integration-admin-session' } }), 'sanction_unsigned'],
            [sanction({ actor: { kind: 'signed_staff_session', principalId: 'staff:m2', capabilities: ['cash.access.manage'] } }), 'sanction_missing_capability'],
            [sanction({ attributionId: 'attr-other' }), 'sanction_other_invitation'],
            [sanction({ sanctionedAt: new Date(AT.getTime() + 1) }), 'sanction_not_yet_effective'],
        ]
        for (const [given, ignored] of cases) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: previouslyRegistered, sanction: given }))).toEqual({
                outcome: 'requires_manager_qualification',
                reason: 'invitee_registered_before_invitation',
                ignored: [ignored],
            })
        }
    })

    it('cannot override park-SMZ, identity, self-referral or a second attribution', () => {
        const withSanction = { sanction: sanction() }
        expect(decideCashReferralQualificationV1(qualification({ ...withSanction, inviteeFacts: { ...previouslyRegistered, isSelfEmployed: false } })))
            .toMatchObject({ outcome: 'not_qualified', reason: 'invitee_not_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ ...withSanction, invitee: { proven: false, refusal: 'identity_needs_review' } })))
            .toMatchObject({ outcome: 'pending', reason: 'invitee_identity_blocked' })
        expect(decideCashReferralQualificationV1(qualification({ ...withSanction, sharedPhone: true })))
            .toMatchObject({ outcome: 'rejected', reason: 'self_referral_suspected' })
        expect(decideCashReferralQualificationV1(qualification({ ...withSanction, inviteeAlreadyAttributed: true })))
            .toMatchObject({ outcome: 'rejected', reason: 'invitee_already_attributed' })
    })
})

describe('self-referral and duplicates', () => {
    it('rejects the same person by Telegram account, contact, merged lineage or person key', () => {
        const base = qualification()
        const selves: Partial<CashReferralQualificationInputV1>[] = [
            { capture: { ...base.capture, inviteeTelegramUserId: '1001' } },
            { invitee: { proven: true, contactId: 'contact-inviter', lineage: ['contact-inviter'], externalPersonKey: 'vu:other' } },
            { invitee: { proven: true, contactId: 'contact-invitee', lineage: ['contact-invitee', 'contact-inviter'], externalPersonKey: 'vu:other' } },
            { inviter: { proven: true, contactId: 'contact-inviter', lineage: ['contact-inviter', 'contact-invitee'], externalPersonKey: 'vu:inviter' } },
            { invitee: { proven: true, contactId: 'contact-invitee', lineage: ['contact-invitee'], externalPersonKey: 'vu:inviter' } },
        ]
        for (const self of selves) {
            expect(decideCashReferralQualificationV1(qualification(self))).toEqual({ outcome: 'rejected', reason: 'self_referral', ignored: [] })
        }
    })

    it('lets a shared phone only block, never qualify', () => {
        expect(decideCashReferralQualificationV1(qualification({ sharedPhone: true })))
            .toEqual({ outcome: 'rejected', reason: 'self_referral_suspected', ignored: [] })
    })

    it('does not treat two people without a person key as the same', () => {
        expect(decideCashReferralQualificationV1(qualification({
            inviter: { proven: true, contactId: 'contact-inviter', lineage: ['contact-inviter'], externalPersonKey: null },
            invitee: { proven: true, contactId: 'contact-invitee', lineage: ['contact-invitee'], externalPersonKey: null },
        }))).toMatchObject({ outcome: 'qualified' })
    })

    it('rejects an invitee another invitation already qualified', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeAlreadyAttributed: true })))
            .toEqual({ outcome: 'rejected', reason: 'invitee_already_attributed', ignored: [] })
    })

    it('records a second qualifying invitee without a second grant', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviterAlreadyEntitled: true })))
            .toMatchObject({ outcome: 'qualified', grant: 'already_entitled', confirmedAt: AT })
    })
})

describe('identity of both people', () => {
    it('holds the invitation while the inviter is blocked or no longer the contact that shared the link', () => {
        const blocked: Partial<CashReferralQualificationInputV1>[] = [
            ...CASH_ACCESS_IDENTITY_REFUSALS_V1.map((refusal) => ({ inviter: { proven: false as const, refusal } })),
            { inviter: { proven: true, contactId: 'contact-survivor', lineage: ['contact-survivor', 'contact-inviter'], externalPersonKey: 'vu:inviter' } },
        ]
        for (const overrides of blocked) {
            expect(decideCashReferralQualificationV1(qualification(overrides))).toEqual({ outcome: 'pending', reason: 'inviter_identity_blocked', ignored: [] })
        }
    })

    it('holds the invitation until the invitee is linked and proven', () => {
        expect(decideCashReferralQualificationV1(qualification({ invitee: { proven: false, refusal: 'not_linked' } })))
            .toEqual({ outcome: 'pending', reason: 'invitee_not_linked', ignored: [] })
        for (const refusal of CASH_ACCESS_IDENTITY_REFUSALS_V1) {
            expect(decideCashReferralQualificationV1(qualification({ invitee: { proven: false, refusal } })))
                .toEqual({ outcome: 'pending', reason: 'invitee_identity_blocked', ignored: [] })
        }
    })
})

describe('determinism', () => {
    it('returns the same answer for the same input and never modifies it', () => {
        const frozen = Object.freeze(qualification({
            inviteeFacts: Object.freeze(previouslyRegistered),
            sanction: Object.freeze(sanction()),
        }))
        expect(decideCashReferralQualificationV1(frozen)).toEqual(decideCashReferralQualificationV1(frozen))
    })
})
