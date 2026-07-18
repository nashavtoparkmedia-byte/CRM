'use strict'
/* eslint-disable @typescript-eslint/no-require-imports */

const test = require('node:test')
const assert = require('node:assert/strict')
const { createAiCallContactResolver } = require('../contact-resolution-core')

function resolver(overrides = {}) {
    const calls = { resolveByPhone: 0 }
    const resolve = createAiCallContactResolver({
        normalizePhone: raw => {
            const digits = String(raw ?? '').replace(/\D/g, '')
            if (digits.length !== 11) return null
            return `+7${digits.slice(1)}`
        },
        findContactById: async () => null,
        findDriverById: async () => null,
        findContactsByPhone: async () => [],
        resolveByPhone: async phone => {
            calls.resolveByPhone += 1
            return { contact: { id: 'created-contact', displayName: phone }, isNew: true }
        },
        ...overrides,
    })
    return { resolve, calls }
}

test('normalizes phone and uses existing canonical Contact without creating a duplicate', async () => {
    const { resolve, calls } = resolver({
        findContactsByPhone: async phone => [{ contactId: 'c1', displayName: phone }],
    })
    const result = await resolve({ phoneNumber: '8 (922) 123-45-67' })
    assert.equal(result.status, 'resolved')
    assert.equal(result.contactId, 'c1')
    assert.equal(result.phoneE164, '+79221234567')
    assert.equal(result.created, false)
    assert.equal(calls.resolveByPhone, 0)
})

test('not found delegates creation to canonical resolveByPhone only', async () => {
    const { resolve, calls } = resolver()
    const result = await resolve({ phoneNumber: '+7 922 123 45 67' })
    assert.equal(result.status, 'resolved')
    assert.equal(result.source, 'canonical_created')
    assert.equal(result.contactId, 'created-contact')
    assert.equal(calls.resolveByPhone, 1)
})

test('ambiguous phone is blocked and never picks or creates a Contact', async () => {
    const { resolve, calls } = resolver({
        findContactsByPhone: async () => [
            { contactId: 'c2', displayName: 'Two' },
            { contactId: 'c1', displayName: 'One' },
        ],
    })
    const result = await resolve({ phoneNumber: '+79221234567' })
    assert.equal(result.status, 'ambiguous')
    assert.deepEqual(result.candidateContactIds, ['c1', 'c2'])
    assert.equal(calls.resolveByPhone, 0)
})

test('explicit Contact preserves contactId and rejects a phone owned by another Contact', async () => {
    const { resolve } = resolver({
        findContactById: async () => ({
            id: 'c1',
            displayName: 'One',
            phones: [{ phone: '+79221234567', isPrimary: true }],
        }),
    })
    const ok = await resolve({ contactId: 'c1' })
    assert.equal(ok.status, 'resolved')
    assert.equal(ok.contactId, 'c1')

    const mismatch = await resolve({ contactId: 'c1', phoneNumber: '+79990000000' })
    assert.deepEqual(mismatch, { status: 'conflict', reason: 'contact_phone_mismatch' })
})

test('missing Contact, missing driver phone and invalid phone fail safely', async () => {
    const missing = resolver()
    assert.equal((await missing.resolve({ contactId: 'missing' })).reason, 'contact_not_found')

    const noPhone = resolver({ findDriverById: async () => ({ id: 'd1', phone: null }) })
    assert.equal((await noPhone.resolve({ driverId: 'd1' })).reason, 'phone_not_found')

    const invalid = resolver()
    assert.equal((await invalid.resolve({ phoneNumber: '123' })).reason, 'invalid_phone')
})
