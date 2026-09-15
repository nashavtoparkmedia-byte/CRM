import { describe, expect, test } from 'vitest'

import { buildCanonicalContactSummary } from './contact-display-policy'

function summary(overrides: { contact?: any; driver?: any } = {}) {
  return buildCanonicalContactSummary({
    contact: {
      displayName: 'Normal Contact',
      displayNameSource: 'channel',
      canonicalPinnedAt: null,
      primaryPhoneId: 'phone-1',
      phones: [{ id: 'phone-1', phone: '+79990000000', isActive: true, lifecycle: 'current' }],
      identities: [{ channel: 'max', externalId: 'opaque-max-id', displayName: 'Provider Human' }],
      driverConfirmations: [],
      ...overrides.contact,
    },
    driver: overrides.driver ?? null,
  })
}

describe('canonical Contact display priority', () => {
  test('uses the exact manual, Fleet, Contact, phone, provider-name, provider-id order', () => {
    expect(summary({ contact: { displayName: 'Manual FIO', displayNameSource: 'manual' } }).displayName)
      .toBe('Manual FIO')
    expect(summary({
      contact: { displayName: 'Normal Contact', driverConfirmations: [{ status: 'confirmed' }] },
      driver: { id: 'd1', fullName: 'Fleet FIO', personResolutionStatus: 'operator_confirmed' },
    }).displayName).toBe('Fleet FIO')
    expect(summary().displayName).toBe('Normal Contact')
    expect(summary({ contact: { displayName: 'Контакт MAX' } }).displayName).toBe('+7 999 000-00-00')
    expect(summary({
      contact: { displayName: 'Контакт MAX', primaryPhoneId: null, phones: [] },
    }).displayName).toBe('Provider Human')
    expect(summary({
      contact: {
        displayName: 'Контакт MAX', primaryPhoneId: null, phones: [],
        identities: [{ channel: 'max', externalId: 'opaque-max-id', displayName: 'MAX: 12345678' }],
      },
    }).displayName).toBe('opaque-max-id')
  })

  test('never promotes a generic provider label over a stable provider identity', () => {
    expect(summary({
      contact: {
        displayName: 'Контакт Telegram', primaryPhoneId: null, phones: [],
        identities: [{ channel: 'telegram', externalId: '987654321', displayName: null }],
      },
    }).displayName).toBe('987654321')
  })
})
