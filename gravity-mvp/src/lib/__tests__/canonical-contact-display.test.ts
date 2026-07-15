import { describe, expect, test } from 'vitest'
import {
  buildCanonicalContactSummary,
  formatContactPhone,
  getSegmentLabel,
} from '@/lib/contact-display'

describe('canonical Contact display summary', () => {
  test('uses the selected active main profile and formats the primary phone', () => {
    const summary = buildCanonicalContactSummary({
      contact: {
        displayName: 'MAX:902158371854',
        displayNameSource: 'channel',
        primaryPhoneId: 'phone-1',
        mainDriverId: 'driver-yoko',
        phones: [{ id: 'phone-1', phone: '+79126646745', isPrimary: true }],
        identities: [{ channel: 'max', externalId: '902158371854', displayName: null }],
      },
      profiles: [
        { id: 'driver-park', fullName: 'Другой Профиль', lastExternalPark: 'Наш Автопарк' },
        { id: 'driver-yoko', fullName: 'Шабуров Евгений Анатольевич', phone: '+79126646745', segment: 'medium', lastExternalPark: 'YOKO' },
      ],
      currentChannel: 'max',
      providerChannels: ['max', 'whatsapp', 'telegram'],
    })

    expect(summary.displayName).toBe('Шабуров Евгений Анатольевич')
    expect(summary.primaryPhone).toBe('+7 912 664-67-45')
    expect(summary.displayTitle).toBe('Шабуров Евгений Анатольевич · +7 912 664-67-45')
    expect(summary.currentMainDriverProfile?.id).toBe('driver-yoko')
    expect(summary.channelCount).toBe(3)
  })

  test('uses park priority when the Contact has no valid main profile', () => {
    const summary = buildCanonicalContactSummary({
      contact: { displayName: 'MAX:1', mainDriverId: null },
      profiles: [
        { id: 'driver-yoko', fullName: 'Профиль YOKO', lastExternalPark: 'YOKO' },
        { id: 'driver-main-park', fullName: 'Профиль Наш Автопарк', lastExternalPark: 'Наш Автопарк' },
        { id: 'driver-dismissed', fullName: 'Уволенный', lastExternalPark: 'Наш Автопарк', dismissedAt: '2026-07-01T00:00:00.000Z' },
      ],
      currentChannel: 'max',
    })

    expect(summary.displayName).toBe('Профиль Наш Автопарк')
    expect(summary.currentMainDriverProfile?.id).toBe('driver-main-park')
  })

  test('falls back through Contact, provider, phone and channel labels', () => {
    expect(buildCanonicalContactSummary({
      contact: { displayName: 'Имя оператора', identities: [] },
      currentChannel: 'telegram',
    }).displayName).toBe('Имя оператора')

    expect(buildCanonicalContactSummary({
      contact: {
        displayName: 'MAX:902158371854',
        identities: [{ channel: 'max', externalId: '902158371854', displayName: 'Евгений MAX' }],
      },
      currentChannel: 'max',
    }).displayName).toBe('Евгений MAX')

    expect(buildCanonicalContactSummary({
      contact: {
        displayName: '902158371854',
        phones: [{ id: 'phone-1', phone: '8 (912) 664-67-45', isPrimary: true }],
      },
      currentChannel: 'max',
    }).displayName).toBe('+7 912 664-67-45')

    expect(buildCanonicalContactSummary({
      contact: { displayName: 'MAX:902158371854' },
      currentChannel: 'max',
    }).displayName).toBe('Контакт MAX')
  })

  test('hides provider ids and counts unique providers', () => {
    const summary = buildCanonicalContactSummary({
      contact: {
        displayName: 'MAX:902158371854',
        identities: [
          { channel: 'max', externalId: '902158371854', displayName: null },
          { channel: 'max', externalId: 'duplicate', displayName: null },
          { channel: 'telegram', externalId: '123', displayName: null },
        ],
      },
      currentChannel: 'max',
    })

    expect(summary.displayName).toBe('Контакт MAX')
    expect(summary.displayName).not.toContain('902158371854')
    expect(summary.channelCount).toBe(2)
  })

  test('maps segments and Russian phone formats', () => {
    expect(formatContactPhone('8 922 215-57-50')).toBe('+7 922 215-57-50')
    expect(formatContactPhone('79222155750')).toBe('+7 922 215-57-50')
    expect(getSegmentLabel('small')).toBe('Малый')
    expect(getSegmentLabel('medium')).toBe('Средний')
    expect(getSegmentLabel('profitable')).toBe('Прибыльный')
    expect(getSegmentLabel('unknown')).toBe('Не определён')
    expect(getSegmentLabel('future_enum')).toBe('Не определён')
  })
})
