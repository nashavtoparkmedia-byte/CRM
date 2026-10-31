import { describe, expect, it } from 'vitest'

import { CASH_ACCESS_IDENTITY_REFUSALS_V1, decideCashAccessV1, type CashAccessActorV1 } from './compensation-access'
import {
    CASH_REFERRAL_QUALIFY_CAPABILITY_V1,
    cashReferralDismissalReadingFromYandexV1,
    decideCashReferralQualificationV1,
    type CashReferralInviteeFactsV1,
    type CashReferralOtherProfileV1,
    type CashReferralPersonV1,
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
        targetParkId: 'park-target',
        isSelfEmployed: true,
        parkHireDate: new Date('2026-11-05T06:00:00.000Z'),
        dismissedAt: null,
        dismissals: [],
        otherProfiles: [],
        ...overrides,
    }
}

/** An earlier profile in the target park, as the fleet last read it. */
function profile(overrides: Partial<CashReferralOtherProfileV1> = {}): CashReferralOtherProfileV1 {
    return {
        parkId: 'park-target',
        registeredAt: new Date('2024-03-01T06:00:00.000Z'),
        readAt: new Date('2026-11-19T19:00:00.000Z'),
        dismissals: [],
        ...overrides,
    }
}

// Dismissed in the summer, read dismissed again after the capture.
const endedInSummer = { dismissedAt: new Date('2026-07-10T09:00:00.000Z'), readAt: new Date('2026-11-03T19:00:00.000Z') }

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

// The proven profile itself predates the invitation and reads connected: possibly a working driver.
const previouslyRegistered = inviteeFacts({ parkHireDate: new Date('2025-06-01T06:00:00.000Z') })
// Hired again after the invitation; an earlier profile in the same park reads connected after the capture.
const reRegisteredInTargetPark = inviteeFacts({ otherProfiles: [profile()] })
// Hired again after the invitation; the earlier profile was dismissed before it.
const returnedToTargetPark = inviteeFacts({ otherProfiles: [profile({ dismissals: [endedInSummer] })] })

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
            .toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
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
            [inviteeFacts({ otherProfiles: null }), 'invitee_registration_history_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ readAt: null })] }), 'invitee_departure_unknown'],
        ]
        for (const [facts, reason] of cases) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts }))).toEqual({ outcome: 'pending', reason, ignored: [] })
        }
    })
})

describe('a returned driver qualifies the inviter without a manager', () => {
    it('qualifies when every earlier target-park profile was dismissed before the capture, as read after it', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: returnedToTargetPark }))).toEqual({
            outcome: 'qualified',
            via: 'returned_park_smz',
            grant: 'grant',
            confirmedAt: AT,
            ignored: [],
        })
    })

    it('reads no length of absence: a minute or years before the capture are the same', () => {
        for (const dismissedAt of ['2026-11-02T07:59:00.000Z', '2019-02-01T06:00:00.000Z']) {
            const facts = inviteeFacts({ otherProfiles: [profile({ dismissals: [{ dismissedAt: new Date(dismissedAt), readAt: CAPTURED_AT }] })] })
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts })), dismissedAt)
                .toMatchObject({ outcome: 'qualified', via: 'returned_park_smz' })
        }
    })

    it('takes no proof from a reading made before the capture, since the profile may have been restored since', () => {
        const readBefore = { dismissedAt: new Date('2026-07-10T09:00:00.000Z'), readAt: new Date('2026-11-02T07:59:59.999Z') }
        expect(decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({ otherProfiles: [profile({ dismissals: [readBefore] })] }),
        }))).toEqual({ outcome: 'needs_review', reason: 'invitee_departure_unproven', ignored: [] })
        expect(decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({ otherProfiles: [profile({ readAt: readBefore.readAt, dismissals: [readBefore] })] }),
        }))).toEqual({ outcome: 'pending', reason: 'invitee_departure_unknown', ignored: [] })
    })

    it('does not count a dismissal at or after the capture: the driver was connected when the link was opened', () => {
        for (const dismissedAt of [CAPTURED_AT, new Date('2026-11-04T06:00:00.000Z')]) {
            const facts = inviteeFacts({ otherProfiles: [profile({ dismissals: [{ dismissedAt, readAt: new Date('2026-11-05T19:00:00.000Z') }] })] })
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts })))
                .toEqual({ outcome: 'needs_review', reason: 'invitee_departure_unproven', ignored: [] })
        }
    })

    it('qualifies a restored profile only through a kept reading that showed it dismissed across the capture', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: { ...previouslyRegistered, dismissals: [endedInSummer] } })))
            .toMatchObject({ outcome: 'qualified', via: 'returned_park_smz', confirmedAt: AT })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: previouslyRegistered })))
            .toEqual({ outcome: 'needs_review', reason: 'invitee_departure_unproven', ignored: [] })
    })

    it('needs every earlier target-park profile to have ended', () => {
        const ended = profile({ dismissals: [endedInSummer] })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ otherProfiles: [ended, ended] }) })))
            .toMatchObject({ outcome: 'qualified', via: 'returned_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ otherProfiles: [ended, profile()] }) })))
            .toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: inviteeFacts({ otherProfiles: [ended, profile({ readAt: null })] }) })))
            .toMatchObject({ outcome: 'pending', reason: 'invitee_departure_unknown' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: { ...previouslyRegistered, otherProfiles: [ended] } })))
            .toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
    })

    it('still needs a connected park-SMZ now', () => {
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: { ...returnedToTargetPark, isSelfEmployed: false } })))
            .toMatchObject({ outcome: 'not_qualified', reason: 'invitee_not_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: { ...returnedToTargetPark, dismissedAt: new Date('2026-11-15T00:00:00.000Z') } })))
            .toMatchObject({ outcome: 'not_qualified', reason: 'invitee_not_connected' })
    })
})

describe('a Yandex read is a dismissal reading only when it states a dismissal date', () => {
    const readAt = new Date('2026-11-03T19:00:00.000Z')

    it('places a fired profile\'s date-only dismissal at the end of that date in every zone', () => {
        expect(cashReferralDismissalReadingFromYandexV1({ workStatus: 'fired', fireDate: '2026-07-10', readAt }))
            .toEqual({ dismissedAt: new Date('2026-07-11T12:00:00.000Z'), readAt })
        // A time part does not make the date more precise than a date.
        expect(cashReferralDismissalReadingFromYandexV1({ workStatus: 'fired', fireDate: '2026-07-10T00:00:00+0000', readAt }))
            .toEqual({ dismissedAt: new Date('2026-07-11T12:00:00.000Z'), readAt })
    })

    it('gives no reading for a working profile, a missing or malformed date, or anything else', () => {
        const none: Array<[string | null, string | null]> = [
            ['working', '2026-07-10'],
            ['not_working', '2026-07-10'],
            [null, '2026-07-10'],
            ['FIRED', '2026-07-10'],
            ['fired', null],
            ['fired', ''],
            ['fired', '2026-02-30'],
            ['fired', '10.07.2026'],
            ['fired', '2026-7-10'],
            ['fired', 'yesterday'],
        ]
        for (const [workStatus, fireDate] of none) {
            expect(cashReferralDismissalReadingFromYandexV1({ workStatus, fireDate, readAt }), `${workStatus} ${fireDate}`).toBeNull()
        }
    })

    it('never proves a departure dated the capture\'s day or the day before it', () => {
        // The capture is 2 November 08:00Z.
        const decide = (fireDate: string) => decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({
                otherProfiles: [profile({
                    readAt,
                    dismissals: [cashReferralDismissalReadingFromYandexV1({ workStatus: 'fired', fireDate, readAt })!],
                })],
            }),
        }))
        expect(decide('2026-11-02')).toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
        expect(decide('2026-11-01')).toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
        expect(decide('2026-10-31')).toMatchObject({ outcome: 'qualified', via: 'returned_park_smz' })
    })
})

describe('a working driver cannot qualify an invitation by opening a link', () => {
    it('asks for a review when an earlier target-park registration is not shown to have ended before the capture', () => {
        for (const facts of [previouslyRegistered, reRegisteredInTargetPark]) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts }))).toEqual({
                outcome: 'needs_review',
                reason: 'invitee_departure_unproven',
                ignored: [],
            })
        }
    })

    it('never qualifies a driver connected through the capture, whatever else holds', () => {
        const variants: Partial<CashReferralQualificationInputV1>[] = [
            {},
            { inviterAlreadyEntitled: true },
            { capture: { ...qualification().capture, capturedAt: new Date('2026-11-19T08:00:00.000Z') } },
            { at: new Date('2030-01-01T00:00:00.000Z') },
            { inviteeFacts: { ...previouslyRegistered, otherProfiles: [profile({ dismissals: [endedInSummer] })] } },
            { inviteeFacts: { ...previouslyRegistered, dismissals: [{ dismissedAt: CAPTURED_AT, readAt: AT }] } },
        ]
        for (const overrides of variants) {
            const decided = decideCashReferralQualificationV1(qualification({ inviteeFacts: previouslyRegistered, ...overrides }))
            expect(decided.outcome).not.toBe('qualified')
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
        // An unknown registration history is resolved by the same sanction (D-1, the Owner's to confirm).
        expect(decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({ otherProfiles: null }),
            sanction: sanction(),
        }))).toMatchObject({ outcome: 'qualified', via: 'manager_sanction' })
    })

    it('ignores a sanction that is unsigned, lacks the capability, names another invitation or is not yet made', () => {
        const cases: Array<[CashReferralSanctionV1, string]> = [
            [sanction({ actor: { kind: 'crm_user', principalId: 'crm_user:u3' } }), 'sanction_unsigned'],
            [sanction({ actor: { kind: 'integration_admin', principalId: 'identity-access:integration-admin-session' } }), 'sanction_unsigned'],
            [sanction({ actor: { kind: 'system', principalId: 'system' } }), 'sanction_unsigned'],
            [sanction({ actor: { kind: 'signed_staff_session', principalId: 'staff:m2', capabilities: ['cash.access.manage'] } }), 'sanction_missing_capability'],
            [sanction({ attributionId: 'attr-other' }), 'sanction_other_invitation'],
            [sanction({ sanctionedAt: new Date(AT.getTime() + 1) }), 'sanction_not_yet_effective'],
        ]
        for (const [given, ignored] of cases) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: previouslyRegistered, sanction: given }))).toEqual({
                outcome: 'needs_review',
                reason: 'invitee_departure_unproven',
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

describe('P4: only the target park counts', () => {
    it('qualifies a new park-SMZ of the target park whatever profiles they hold in other parks', () => {
        const elsewhere = inviteeFacts({
            otherProfiles: [
                profile({ parkId: 'park-other', registeredAt: new Date('2019-04-01T06:00:00.000Z') }),
                profile({ parkId: 'park-third', registeredAt: null, readAt: null }),
            ],
        })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: elsewhere }))).toEqual({
            outcome: 'qualified',
            via: 'new_park_smz',
            grant: 'grant',
            confirmedAt: AT,
            ignored: [],
        })
    })

    it('counts an earlier target-park profile from the capture\'s own business day as after it, and the day before as before', () => {
        // 2 November local runs 2026-11-01T19:00Z to 2026-11-02T19:00Z.
        const at = (registeredAt: string) => inviteeFacts({ otherProfiles: [profile({ registeredAt: new Date(registeredAt) })] })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: at('2026-11-01T19:00:00.000Z') })))
            .toMatchObject({ outcome: 'qualified', via: 'new_park_smz' })
        expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: at('2026-11-01T18:59:59.999Z') })))
            .toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
    })

    it('never qualifies on an unknown target-park history without a manager', () => {
        const unknowns: Array<[CashReferralInviteeFactsV1, string]> = [
            [inviteeFacts({ otherProfiles: null }), 'invitee_registration_history_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ registeredAt: null })] }), 'invitee_registration_history_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ registeredAt: null, dismissals: [endedInSummer] })] }), 'invitee_registration_history_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ dismissals: [endedInSummer] }), profile({ registeredAt: null })] }), 'invitee_registration_history_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ readAt: null })] }), 'invitee_departure_unknown'],
            [inviteeFacts({ otherProfiles: [profile({ readAt: new Date('2026-10-30T19:00:00.000Z') })] }), 'invitee_departure_unknown'],
        ]
        for (const [facts, reason] of unknowns) {
            expect(decideCashReferralQualificationV1(qualification({ inviteeFacts: facts }))).toEqual({ outcome: 'pending', reason, ignored: [] })
        }
        // A known earlier registration that reads connected decides even beside an unknown one.
        expect(decideCashReferralQualificationV1(qualification({
            inviteeFacts: inviteeFacts({ otherProfiles: [profile({ registeredAt: null }), profile()] }),
        }))).toMatchObject({ outcome: 'needs_review', reason: 'invitee_departure_unproven' })
    })

    it('never qualifies without a confirmed park-SMZ, a proven identity and the invitation bound to the inviter', () => {
        const missing: Array<[string, Partial<CashReferralQualificationInputV1>]> = [
            ['SMZ stated false', { inviteeFacts: inviteeFacts({ isSelfEmployed: false }) }],
            ['SMZ unknown', { inviteeFacts: inviteeFacts({ isSelfEmployed: null }) }],
            ['dismissed', { inviteeFacts: inviteeFacts({ dismissedAt: new Date('2026-11-10T00:00:00.000Z') }) }],
            ['hire date unknown', { inviteeFacts: inviteeFacts({ parkHireDate: null }) }],
            ['facts unavailable', { inviteeFacts: null }],
            ['invitee not linked', { invitee: { proven: false, refusal: 'not_linked' } }],
            ['invitee identity unproven', { invitee: { proven: false, refusal: 'identity_not_proven' } }],
            ['inviter identity unproven', { inviter: { proven: false, refusal: 'identity_busy' } }],
            ['inviter is another contact than the one that shared the link', {
                inviter: { proven: true, contactId: 'contact-elsewhere', lineage: ['contact-elsewhere'], externalPersonKey: 'vu:inviter' } as CashReferralPersonV1,
            }],
        ]
        for (const [label, overrides] of missing) {
            for (const withSanction of [null, sanction()]) {
                const decided = decideCashReferralQualificationV1(qualification({ ...overrides, sanction: withSanction }))
                expect(decided.outcome, `${label} / sanction=${withSanction !== null}`).not.toBe('qualified')
            }
        }
    })
})

describe('the invited person gains nothing from the invitation', () => {
    it('decides the inviter\'s access only', () => {
        const decided = decideCashReferralQualificationV1(qualification({ inviteeFacts: returnedToTargetPark }))
        expect(Object.keys(decided).sort()).toEqual(['confirmedAt', 'grant', 'ignored', 'outcome', 'via'])
    })

    it('leaves a returned driver on the standard programme, which gives a restored old profile no first month', () => {
        const restored = { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: new Date('2025-06-01T06:00:00.000Z') }
        expect(decideCashAccessV1({
            identity: { proven: true },
            standardFacts: restored,
            referral: null,
            manual: null,
            ownerPolicy: {},
            at: AT,
        })).toMatchObject({ access: 'refused', reasons: ['outside_first_calendar_month', 'no_entitlement'] })
    })

    it('pins today\'s standard rule: a new profile\'s own hire date opens its first month (P8 is the Owner\'s)', () => {
        const newProfile = { isSelfEmployed: true, employmentType: 'selfemployed', parkHireDate: new Date('2026-11-05T06:00:00.000Z') }
        expect(decideCashAccessV1({
            identity: { proven: true },
            standardFacts: newProfile,
            referral: null,
            manual: null,
            ownerPolicy: {},
            at: AT,
        })).toMatchObject({ access: 'granted', windows: [{ basis: 'park_smz' }] })
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
