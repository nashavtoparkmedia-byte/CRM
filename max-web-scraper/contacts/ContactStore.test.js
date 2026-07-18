'use strict'

const assert = require('node:assert/strict')
const test = require('node:test')

const { ContactStore } = require('./ContactStore')

test('opcode 32 contact phone carries trusted provider-profile evidence', () => {
  const store = new ContactStore()
  store.ingest({
    contacts: [{
      id: 902158371854,
      phone: '+79222155750',
      names: [{ firstName: 'Евгений', lastName: 'Шабуров' }],
    }],
  })

  assert.equal(store.getPhone('902158371854'), '+79222155750')
  assert.deepEqual(
    {
      sourceKind: store.getPhoneEvidence('902158371854').sourceKind,
      trustedForAutomaticResolution: store.getPhoneEvidence('902158371854').trustedForAutomaticResolution,
    },
    { sourceKind: 'provider_profile', trustedForAutomaticResolution: true },
  )
  assert.ok(Date.parse(store.getPhoneEvidence('902158371854').observedAt))
})

test('cache-only phone mapping does not inherit provider trust', () => {
  const store = new ContactStore()
  store._map.set('902158371854', {
    name: null,
    firstName: null,
    lastName: null,
    phone: '79222155750',
  })

  assert.equal(store.getPhone('902158371854'), '79222155750')
  assert.equal(store.getPhoneEvidence('902158371854'), null)
})
