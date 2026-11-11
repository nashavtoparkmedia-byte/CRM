import { describe, expect, it } from 'vitest'

import {
  looksLikePhone as legacyLooksLikePhone,
  normalizePhoneE164 as legacyNormalizePhoneE164,
  parseExternalChatId as legacyParseExternalChatId,
  stripToDigits as legacyStripToDigits,
} from '@/lib/phoneUtils'
import {
  e164CountryCodeV1,
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

  it('reads every Russian form exactly as before', () => {
    for (const input of [
      '+79221234567', '79221234567', '89221234567', '9221234567',
      '+7 (922) 123-45-67', '8 (922) 123-45-67', '8-922-123-45-67', ' 7 922 123 45 67 ',
      '+8 922 123 45 67', '+89221234567', '0079221234567', '00 7 922 123 45 67',
    ]) {
      expect(normalizePhoneE164(input), input).toBe('+79221234567')
    }
    // Landlines and Kazakhstan share +7 and the same rule.
    expect(normalizePhoneE164('8 (343) 123-45-67')).toBe('+73431234567')
    expect(normalizePhoneE164('+7 701 123 45 67')).toBe('+77011234567')
    // A «+» with ten digits is the usual slip for a Russian number, as it always was.
    expect(normalizePhoneE164('+9221234567')).toBe('+79221234567')
  })

  it('keeps an international number digit for digit instead of cutting it to +7 and the last ten', () => {
    const cases: Array<[string, string]> = [
      ['+998 90 123 45 67', '+998901234567'], // Uzbekistan
      ['998901234567', '+998901234567'],
      ['00998901234567', '+998901234567'],
      ['+996 555 123 456', '+996555123456'], // Kyrgyzstan
      ['996555123456', '+996555123456'],
      ['+992 93 123 4567', '+992931234567'], // Tajikistan
      ['992931234567', '+992931234567'],
      ['+993 65 123456', '+99365123456'], // Turkmenistan
      ['+994 50 123 45 67', '+994501234567'], // Azerbaijan
      ['+995 555 12 34 56', '+995555123456'], // Georgia
      ['+374 91 234567', '+37491234567'], // Armenia: 11 digits, null before
      ['37491234567', '+37491234567'],
      ['+373 69 123456', '+37369123456'], // Moldova: 11 digits, null before
      ['+375 29 123 45 67', '+375291234567'], // Belarus
      ['+380 50 123 4567', '+380501234567'], // Ukraine
      ['+359 88 123 4567', '+359881234567'], // Bulgaria: became a valid-looking +7 988 before
      ['+49 151 23456789', '+4915123456789'], // Germany
      ['+86 138 0013 8000', '+8613800138000'], // China, with the explicit «+»
      ['+1 202 555 0123', '+12025550123'], // USA
      ['+90 532 123 45 67', '+905321234567'], // Turkey
    ]
    for (const [input, expected] of cases) {
      expect(normalizePhoneE164(input), input).toBe(expected)
      expect(normalizePhoneE164(expected), `${expected} is stable`).toBe(expected)
    }
  })

  it('never synthesizes a number: junk around a Russian number, unknown codes and odd lengths are not phones', () => {
    for (const input of [
      '8 922 123 45 67 доб. 12', // a Russian number with an extension
      '89221234567, 89227654321', // two numbers in one field
      '7922123456789', // +7 with extra digits
      '+7 922 123 45 67 8', // the same with a «+»
      '8613800138000', // a bare 8…: refused rather than guessed
      '+0123456789012', // no country code starts with 0
      '+21012345678', // 210 is not an assigned country code
      '1234567', '+1234567', // too short
      '+1234567890123456', // more than 15 digits
      '22334455', // a bare short digit string is not a phone
      '', '   ', 'invalid', '+',
    ]) {
      expect(normalizePhoneE164(input), input).toBeNull()
    }
    expect(normalizePhoneE164(null)).toBeNull()
    expect(normalizePhoneE164(undefined)).toBeNull()
  })

  it('finds the one assigned country code a number starts with', () => {
    expect(e164CountryCodeV1('998901234567')).toBe('998')
    expect(e164CountryCodeV1('4915123456789')).toBe('49')
    expect(e164CountryCodeV1('12025550123')).toBe('1')
    expect(e164CountryCodeV1('79221234567')).toBe('7')
    expect(e164CountryCodeV1('0123')).toBeNull()
    expect(e164CountryCodeV1('2101234567')).toBeNull()
    expect(e164CountryCodeV1('')).toBeNull()
  })
})
