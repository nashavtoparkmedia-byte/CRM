import { describe, expect, it } from 'vitest'

import {
    decideTelegramAttestedPhoneV1,
    telegramOwnershipProvenV1,
    type TelegramAttestedPhoneInputV1,
    type TelegramIdentitySnapshotV1,
} from './telegram-attested-phone'

const OBSERVED_AT = new Date('2026-09-13T10:00:00.000Z')

/** Exact digits-only normalizer; the repository parser is injected in production. */
function normalize(raw: string): string | null {
    const digits = raw.replace(/\D/g, '')
    if (digits.length !== 11) return null
    return `+${digits}`
}

function input(overrides: {
    sharedContactUserId?: string | null
    rawPhone?: string
    identity?: TelegramIdentitySnapshotV1 | null
    owners?: string[]
}): TelegramAttestedPhoneInputV1 {
    return {
        attestation: {
            telegramUserId: '777',
            sharedContactUserId: overrides.sharedContactUserId === undefined ? '777' : overrides.sharedContactUserId,
            rawPhone: overrides.rawPhone ?? '+7 900 111-22-33',
            observedAt: OBSERVED_AT,
        },
        identity: overrides.identity === undefined
            ? { identityId: 'ident-1', contactId: 'contact-tg', isActive: true, contactIsBare: true }
            : overrides.identity,
        phoneOwnership: { contactIds: overrides.owners ?? [] },
        normalizePhone: normalize,
    }
}

describe('telegram ownership proof', () => {
    it('accepts a card whose user id is the sending account', () => {
        expect(telegramOwnershipProvenV1({
            telegramUserId: '777', sharedContactUserId: '777', rawPhone: '+79001112233', observedAt: OBSERVED_AT,
        })).toBe(true)
    })

    it('rejects a forwarded card belonging to someone else', () => {
        expect(telegramOwnershipProvenV1({
            telegramUserId: '777', sharedContactUserId: '888', rawPhone: '+79001112233', observedAt: OBSERVED_AT,
        })).toBe(false)
    })

    it('treats a missing user id as no evidence rather than weak evidence', () => {
        expect(telegramOwnershipProvenV1({
            telegramUserId: '777', sharedContactUserId: null, rawPhone: '+79001112233', observedAt: OBSERVED_AT,
        })).toBe(false)
    })
})

describe('case A: phone belongs to no contact', () => {
    it('attaches the attested phone to the contact holding the telegram identity', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: [] }))
        expect(decision).toEqual({
            kind: 'attach_phone_to_identity_contact',
            normalizedPhone: '+79001112233',
            contactId: 'contact-tg',
            identityId: 'ident-1',
        })
    })
})

describe('case B: phone belongs to the same contact', () => {
    it('confirms the binding and moves nothing', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-tg'] }))
        expect(decision).toEqual({
            kind: 'confirm_existing_binding',
            normalizedPhone: '+79001112233',
            contactId: 'contact-tg',
            identityId: 'ident-1',
        })
    })

    it('collapses a duplicated owner entry instead of calling it ambiguous', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-tg', 'contact-tg'] }))
        expect(decision.kind).toBe('confirm_existing_binding')
    })
})

describe('case C: phone belongs to a different canonical contact', () => {
    it('merges the bare telegram contact into the phone owner, never the reverse', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-person'] }))
        expect(decision).toEqual({
            kind: 'merge_identity_contact_into_phone_owner',
            normalizedPhone: '+79001112233',
            sourceContactId: 'contact-tg',
            survivorContactId: 'contact-person',
            identityId: 'ident-1',
        })
    })

    it('never copies the phone onto the telegram contact, so one phone keeps one owner', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-person'] }))
        expect(decision.kind).not.toBe('attach_phone_to_identity_contact')
    })

    it('sends a non-bare telegram contact to manual review instead of merging a possible second person', () => {
        const decision = decideTelegramAttestedPhoneV1(input({
            owners: ['contact-person'],
            identity: { identityId: 'ident-1', contactId: 'contact-tg', isActive: true, contactIsBare: false },
        }))
        expect(decision).toMatchObject({ kind: 'manual_review', reason: 'identity_contact_is_not_bare' })
    })
})

describe('case D: ambiguous phone ownership', () => {
    it('fails closed and names every candidate', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-a', 'contact-b'] }))
        expect(decision).toEqual({
            kind: 'fail_closed',
            reason: 'phone_owned_by_several_contacts',
            candidateContactIds: ['contact-a', 'contact-b'],
        })
    })

    it('refuses ambiguity before considering any identity state', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ owners: ['contact-a', 'contact-b'], identity: null }))
        expect(decision).toMatchObject({ kind: 'fail_closed', reason: 'phone_owned_by_several_contacts' })
    })
})

describe('case E: no telegram channel identity on record', () => {
    it('attaches the identity to the single canonical phone owner', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ identity: null, owners: ['contact-person'] }))
        expect(decision).toEqual({
            kind: 'attach_identity_to_phone_owner',
            normalizedPhone: '+79001112233',
            contactId: 'contact-person',
        })
    })

    it('fails closed when there is neither an identity nor a phone owner', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ identity: null, owners: [] }))
        expect(decision).toMatchObject({ kind: 'fail_closed', reason: 'no_identity_and_no_phone_owner' })
    })
})

describe('fail-closed guards', () => {
    it('refuses unproven ownership before reading any phone', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ sharedContactUserId: '888', owners: ['contact-person'] }))
        expect(decision).toEqual({ kind: 'fail_closed', reason: 'ownership_not_proven', candidateContactIds: [] })
    })

    it('refuses a phone it cannot parse exactly', () => {
        const decision = decideTelegramAttestedPhoneV1(input({ rawPhone: '12345' }))
        expect(decision).toMatchObject({ kind: 'fail_closed', reason: 'phone_unparseable' })
    })

    it('does not silently revive an identity somebody deactivated', () => {
        const decision = decideTelegramAttestedPhoneV1(input({
            identity: { identityId: 'ident-1', contactId: 'contact-tg', isActive: false, contactIsBare: true },
            owners: ['contact-person'],
        }))
        expect(decision).toMatchObject({ kind: 'manual_review', reason: 'identity_inactive' })
    })

    it('never uses a name as evidence: the decision input has no name field', () => {
        const built = input({})
        expect(JSON.stringify(built.attestation)).not.toMatch(/name/i)
    })
})
