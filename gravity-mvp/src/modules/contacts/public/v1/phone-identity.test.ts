import { describe, expect, it } from 'vitest'

import {
  looksLikePhone as legacyLooksLikePhone,
  normalizePhoneE164 as legacyNormalizePhoneE164,
  parseExternalChatId as legacyParseExternalChatId,
  stripToDigits as legacyStripToDigits,
} from '@/lib/phoneUtils'
import {
  looksLikePhone,
  normalizePhoneE164,
  parseExternalChatId,
  stripToDigits,
} from './phone-identity'

describe('Contacts phone identity public policy', () => {
  it('keeps the legacy path as exact aliases', () => {
    expect(legacyNormalizePhoneE164).toBe(normalizePhoneE164)
    expect(legacyParseExternalChatId).toBe(parseExternalChatId)
    expect(legacyLooksLikePhone).toBe(looksLikePhone)
    expect(legacyStripToDigits).toBe(stripToDigits)
  })

  it('preserves canonical Russian E.164 and external chat parsing behavior', () => {
    expect(normalizePhoneE164('8 (922) 123-45-67')).toBe('+79221234567')
    expect(normalizePhoneE164('invalid')).toBeNull()
    expect(parseExternalChatId('max_name:Driver')).toEqual({ channel: 'max', externalId: 'name_Driver' })
    expect(parseExternalChatId('unknown:value')).toEqual({ channel: 'unknown', externalId: 'unknown:value' })
    expect(looksLikePhone('+7 922 123-45-67')).toBe(true)
    expect(stripToDigits('+7 922')).toBe('7922')
  })
})
