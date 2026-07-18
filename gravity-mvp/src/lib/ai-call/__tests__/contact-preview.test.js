/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { resolvePreviewContact } = require('../contact-preview.ts')

test('invalid phone is rejected without a Contact', () => {
    const result = resolvePreviewContact('123')
    assert.equal(result.status, 'INVALID')
    assert.equal(result.contactId, null)
})

test('not found never creates a Contact', () => {
    const result = resolvePreviewContact('+7 999 000-00-03')
    assert.equal(result.status, 'NOT_FOUND')
    assert.equal(result.contactId, null)
    assert.equal(result.productionWriteAllowed, false)
})

test('one canonical mock Contact is matched with normalized phone', () => {
    const result = resolvePreviewContact('8 (999) 000-00-01')
    assert.equal(result.status, 'MATCHED')
    assert.equal(result.contactId, 'contact-preview-001')
    assert.equal(result.normalizedPhone, '+79990000001')
})

test('ambiguous phone blocks selection and reports candidate count', () => {
    const result = resolvePreviewContact('+79990000002')
    assert.equal(result.status, 'AMBIGUOUS')
    assert.equal(result.contactId, null)
    assert.equal(result.candidateCount, 2)
})

test('retry is deterministic and read-only', () => {
    const first = resolvePreviewContact('+79990000001')
    const retry = resolvePreviewContact('+79990000001')
    assert.deepEqual(first, retry)
    assert.equal(first.productionWriteAllowed, false)
})
