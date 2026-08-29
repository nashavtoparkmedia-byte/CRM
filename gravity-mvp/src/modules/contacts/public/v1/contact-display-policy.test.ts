import { describe, expect, it } from 'vitest'

import {
  buildCanonicalContactSummary,
  formatContactPhone,
  getSegmentLabel,
} from './contact-display-policy'

describe('Contacts canonical display policy', () => {
  it('preserves Russian phone formatting and known segment labels', () => {
    expect(formatContactPhone('8 (999) 123-45-67')).toBe('+7 999 123-45-67')
    expect(formatContactPhone('9991234567')).toBe('+7 999 123-45-67')
    expect(getSegmentLabel('vip')).toBe('VIP')
    expect(getSegmentLabel('not-known')).toBe('Не определён')
  })

  it('rejects technical provider names and falls back to canonical identity data', () => {
    const summary = buildCanonicalContactSummary({
      currentChannel: 'telegram',
      contact: {
        displayName: 'TG: 123456789',
        phones: [{ id: 'phone-1', phone: '+79991234567', isPrimary: true }],
        identities: [{ channel: 'telegram', externalId: '123456789', displayName: 'telegram:123456789' }],
      },
    })

    expect(summary.displayName).toBe('+7 999 123-45-67')
    expect(summary.displayTitle).toBe('+7 999 123-45-67')
    expect(summary.channelCount).toBe(1)
  })
})
