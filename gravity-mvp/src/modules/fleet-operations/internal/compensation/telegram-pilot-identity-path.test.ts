/**
 * End-to-end proof of the pilot identity path.
 *
 * A newly connected driver opens the bot, shares their own contact, and must
 * arrive at proven canonical-person evidence the monetary core accepts. Each
 * hop below is the real decision function from its owning module; only the
 * stored world is a stand-in. Nothing here relaxes what C1 demands.
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
    decideTelegramAttestedPhoneV1,
    type TelegramIdentitySnapshotV1,
} from '../../../contacts/internal/telegram-attested-phone'
import { matchYandexProfileByExactPhoneV1 } from '../../../telegram-channel/public/v1/yandex-profile-match'
import { compensationPilotEligibilityV1 } from './compensation-eligibility'
import {
    resolveCompensationPersonV1,
    type CompensationPersonBindingRecordV1,
} from './compensation-person-resolution'
import type { ProvenCanonicalPersonV1 } from './compensation-ports'

const ATTESTED_PHONE = '+79001112233'
const NOW = new Date('2026-09-20T09:00:00.000Z')

function normalize(raw: string): string | null {
    const digits = raw.replace(/\D/g, '')
    return digits.length === 11 ? `+${digits}` : null
}

/** Evidence exactly as Contacts would hand it to the monetary core. */
function provenPerson(canonicalContactId: string, lineage: string[]): ProvenCanonicalPersonV1 {
    const ordered = [...new Set([canonicalContactId, ...lineage])].sort()
    return {
        canonicalContactId,
        resolutionStatus: 'live',
        lineage: ordered,
        lineageDigest: createHash('sha256').update(ordered.join(',')).digest('hex'),
        evidenceAt: NOW,
    }
}

/** One park's profiles, as the Fleet API returns them. */
const parkProfiles = [
    { id: 'profile-new', phones: [ATTESTED_PHONE], workStatus: 'working' },
    { id: 'profile-other', phones: ['+79005554433'], workStatus: 'working' },
]

function share(identity: TelegramIdentitySnapshotV1 | null, owners: string[]) {
    return decideTelegramAttestedPhoneV1({
        attestation: {
            telegramUserId: '777',
            sharedContactUserId: '777',
            rawPhone: ATTESTED_PHONE,
            observedAt: NOW,
        },
        identity,
        phoneOwnership: { contactIds: owners },
        normalizePhone: normalize,
    })
}

describe('a newly connected telegram driver reaches proven canonical person', () => {
    it('walks share, exact profile match, contact binding and person resolution', () => {
        // 1. Telegram attests the number and the park yields exactly one profile.
        const match = matchYandexProfileByExactPhoneV1(ATTESTED_PHONE, parkProfiles)
        expect(match).toEqual({ kind: 'matched', profileId: 'profile-new' })

        // 2. The number is new to Contacts, so it lands on the contact that
        //    already holds this Telegram identity. No second owner is created.
        const decision = share(
            { identityId: 'ident-1', contactId: 'contact-new', isActive: true, contactIsBare: true },
            [],
        )
        expect(decision).toMatchObject({ kind: 'attach_phone_to_identity_contact', contactId: 'contact-new' })

        // 3. That canonical contact becomes the evidence the monetary core reads.
        const resolution = resolveCompensationPersonV1(provenPerson('contact-new', []), [])
        expect(resolution).toEqual({ status: 'create', contactIds: ['contact-new'] })
    })

    it('is eligible when the park states self-employed and a hire date in this month', () => {
        const decision = compensationPilotEligibilityV1({
            isSelfEmployed: true,
            employmentType: 'selfemployed',
            parkHireDate: new Date('2026-09-02T06:00:00.000Z'),
        }, NOW)
        expect(decision).toMatchObject({ eligible: true, firstMonthKey: '2026-09' })
    })

    it('reaches the same monetary person on a second visit, never a second one', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'comp_person_1', contactId: 'contact-new' },
        ]
        const resolution = resolveCompensationPersonV1(provenPerson('contact-new', []), bindings)
        expect(resolution).toEqual({
            status: 'existing',
            compensationPersonId: 'comp_person_1',
            missingContactIds: [],
        })
    })
})

describe('the duplicate contact case does not split one person in two', () => {
    it('merges the bare telegram contact into the canonical owner of the phone', () => {
        const decision = share(
            { identityId: 'ident-1', contactId: 'contact-bot', isActive: true, contactIsBare: true },
            ['contact-person'],
        )
        expect(decision).toMatchObject({
            kind: 'merge_identity_contact_into_phone_owner',
            sourceContactId: 'contact-bot',
            survivorContactId: 'contact-person',
        })
    })

    it('leaves exactly one monetary person once the merged lineage is presented', () => {
        // The survivor already owns the monetary person; the merged-away id
        // stays in the lineage so history still resolves to the same person.
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'comp_person_1', contactId: 'contact-person' },
        ]
        const resolution = resolveCompensationPersonV1(
            provenPerson('contact-person', ['contact-bot']),
            bindings,
        )
        expect(resolution).toEqual({
            status: 'existing',
            compensationPersonId: 'comp_person_1',
            missingContactIds: ['contact-bot'],
        })
    })

    it('fails closed rather than choosing when the lineage spans two monetary people', () => {
        const bindings: CompensationPersonBindingRecordV1[] = [
            { compensationPersonId: 'comp_person_1', contactId: 'contact-person' },
            { compensationPersonId: 'comp_person_2', contactId: 'contact-bot' },
        ]
        const resolution = resolveCompensationPersonV1(
            provenPerson('contact-person', ['contact-bot']),
            bindings,
        )
        expect(resolution).toMatchObject({ status: 'fail_closed' })
    })
})

describe('ambiguity never reaches the monetary core', () => {
    it('stops at the share when two contacts own the number', () => {
        const decision = share(
            { identityId: 'ident-1', contactId: 'contact-bot', isActive: true, contactIsBare: true },
            ['contact-a', 'contact-b'],
        )
        expect(decision).toMatchObject({ kind: 'fail_closed', reason: 'phone_owned_by_several_contacts' })
    })

    it('stops at the park when two live profiles share the number', () => {
        const match = matchYandexProfileByExactPhoneV1(ATTESTED_PHONE, [
            { id: 'a', phones: [ATTESTED_PHONE], workStatus: 'working' },
            { id: 'b', phones: [ATTESTED_PHONE], workStatus: 'working' },
        ])
        expect(match).toMatchObject({ kind: 'ambiguous' })
    })

    it('stops at the share when the card was forwarded from another account', () => {
        const decision = decideTelegramAttestedPhoneV1({
            attestation: {
                telegramUserId: '777',
                sharedContactUserId: '888',
                rawPhone: ATTESTED_PHONE,
                observedAt: NOW,
            },
            identity: { identityId: 'ident-1', contactId: 'contact-bot', isActive: true, contactIsBare: true },
            phoneOwnership: { contactIds: ['contact-person'] },
            normalizePhone: normalize,
        })
        expect(decision).toMatchObject({ kind: 'fail_closed', reason: 'ownership_not_proven' })
    })
})
