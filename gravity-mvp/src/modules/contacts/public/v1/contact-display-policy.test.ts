import { describe, expect, test } from 'vitest'

import { buildCanonicalContactSummary, buildProviderNeutralContactDisplayV1 } from './contact-display-policy'

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

function neutralContact(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'Normal Contact',
    displayNameSource: 'channel',
    canonicalPinnedAt: null,
    primaryPhoneId: 'phone-1',
    phones: [{ id: 'phone-1', phone: '+79990000000', isActive: true, lifecycle: 'current' }],
    identities: [{ channel: 'max', externalId: 'opaque-max-id', displayName: 'Provider Human' }],
    ...overrides,
  }
}

describe('provider-neutral Contact display', () => {
  test('keeps the canonical manual, confirmed-person, Contact, phone and provider-name order', () => {
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact({ displayName: 'Manual FIO', displayNameSource: 'manual' }),
    }).displayName).toBe('Manual FIO')
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact(),
      confirmedPersonName: 'Confirmed FIO',
    }).displayName).toBe('Confirmed FIO')
    expect(buildProviderNeutralContactDisplayV1({ contact: neutralContact() }).displayName)
      .toBe('Normal Contact')
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact({ displayName: 'Контакт MAX' }),
    }).displayName).toBe('+7 999 000-00-00')
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact({ displayName: 'Контакт MAX', primaryPhoneId: null, phones: [] }),
    }).displayName).toBe('Provider Human')
  })

  test('a manual pin still outranks a confirmed person name', () => {
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact({ displayName: 'Manual FIO', canonicalPinnedAt: '2026-09-01T00:00:00.000Z' }),
      confirmedPersonName: 'Confirmed FIO',
    }).displayName).toBe('Manual FIO')
  })

  test('a technical confirmed person name is rejected like any other technical name', () => {
    expect(buildProviderNeutralContactDisplayV1({
      contact: neutralContact({ displayName: 'Контакт MAX', primaryPhoneId: null, phones: [] }),
      confirmedPersonName: 'MAX: 12345678',
    }).displayName).toBe('Provider Human')
  })

  test('refuses the provider external id the canonical summary would have used', () => {
    // These are exactly the two cases the canonical cascade resolves to a raw
    // provider target. The provider-neutral projection must reach the generic
    // fallback instead, and the value must appear nowhere in its output.
    for (const identities of [
      [{ channel: 'max', externalId: 'opaque-max-id', displayName: 'MAX: 12345678' }],
      [{ channel: 'telegram', externalId: '987654321', displayName: null }],
    ]) {
      const contact = neutralContact({
        displayName: 'Контакт MAX', primaryPhoneId: null, phones: [], identities,
      })
      const canonical = buildCanonicalContactSummary({ contact, driver: null })
      const neutral = buildProviderNeutralContactDisplayV1({ contact })
      expect(canonical.displayName).toBe(String(identities[0].externalId))
      expect(neutral.displayName).toBe('Контакт')
      expect(neutral.displayTitle).toBe('Контакт')
      expect(JSON.stringify(neutral)).not.toContain(String(identities[0].externalId))
    }
  })

  test('agrees with the canonical summary wherever a provider id is not the answer', () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { displayName: 'Manual FIO', displayNameSource: 'manual' },
      { displayName: 'Контакт MAX' },
      { displayName: 'Контакт MAX', primaryPhoneId: null, phones: [] },
      { displayName: null },
      { phones: [{ id: 'phone-1', phone: '+79990000000', isActive: false, lifecycle: 'removed' }] },
      { identities: [] },
    ]
    for (const overrides of cases) {
      const contact = neutralContact(overrides)
      const canonical = buildCanonicalContactSummary({ contact, driver: null })
      const neutral = buildProviderNeutralContactDisplayV1({ contact })
      if (canonical.displayName === 'opaque-max-id') continue
      expect(neutral).toEqual({
        displayName: canonical.displayName,
        displayTitle: canonical.displayTitle,
        primaryPhone: canonical.primaryPhone,
      })
    }
  })

  test('survives an absent contact', () => {
    expect(buildProviderNeutralContactDisplayV1({})).toEqual({
      displayName: 'Контакт', displayTitle: 'Контакт', primaryPhone: null,
    })
    expect(buildProviderNeutralContactDisplayV1({ contact: null, confirmedPersonName: null })).toEqual({
      displayName: 'Контакт', displayTitle: 'Контакт', primaryPhone: null,
    })
  })
})
