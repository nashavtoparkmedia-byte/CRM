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
  })

  it('never reads an explicitly international number as Russian (Security R1, R2)', () => {
    // «+» or «00» with ten digits is read by its country code, never as +7.
    expect(normalizePhoneE164('+49 511 12345')).toBe('+4951112345')
    expect(normalizePhoneE164('0049 511 12345')).toBe('+4951112345')
    expect(normalizePhoneE164('+46 8 1234567')).toBe('+4681234567')
    // «+8x…» with eleven digits: only «+89…» is the Russian slip; the rest is ambiguous.
    expect(normalizePhoneE164('+84 912 345 678')).toBeNull()
    expect(normalizePhoneE164('+8 (495) 123-45-67')).toBeNull()
    expect(normalizePhoneE164('008 495 123 45 67')).toBeNull()
    expect(normalizePhoneE164('+8 922 123 45 67')).toBe('+79221234567')
    // Bare digits keep the national reading.
    expect(normalizePhoneE164('84951234567')).toBe('+74951234567')
    expect(normalizePhoneE164('4951234567')).toBe('+74951234567')
  })

  it('keeps explicit international numbers of 8 to 10 digits and refuses shorter ones (Security R3)', () => {
    expect(normalizePhoneE164('+680 12345')).toBe('+68012345') // Palau, 8 digits
    expect(normalizePhoneE164('+376 312 345')).toBe('+376312345') // Andorra, 9 digits
    expect(normalizePhoneE164('+354 123 4567')).toBe('+3541234567') // Iceland, 10 digits
    expect(normalizePhoneE164('00354 123 4567')).toBe('+3541234567')
    expect(normalizePhoneE164('+376 3123')).toBeNull() // 7 digits
    expect(normalizePhoneE164('+3541234')).toBeNull()
    // The same lengths bare are not phones (a bare international number needs 11+).
    expect(normalizePhoneE164('376312345')).toBeNull()
    expect(normalizePhoneE164('68012345')).toBeNull()
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
