import { describe, expect, it } from 'vitest'

import { DRIVER_LICENCE_MASK_V1, driverLicenceKeyV1, maskDriverLicenceV1 } from './driver-licence-mask'

const NEW_FORMAT = '99 12 345678'
const OLD_FORMAT = '77 АВ 123456'

describe('maskDriverLicenceV1', () => {
  it('shows the stored licence only for the exact full view', () => {
    expect(maskDriverLicenceV1(NEW_FORMAT, 'full')).toBe(NEW_FORMAT)
    expect(maskDriverLicenceV1(`  ${OLD_FORMAT} `, 'full')).toBe(OLD_FORMAT)
  })

  it('shows only the last four letters or digits for last4', () => {
    expect(maskDriverLicenceV1(NEW_FORMAT, 'last4')).toBe(`${DRIVER_LICENCE_MASK_V1} 5678`)
    expect(maskDriverLicenceV1(OLD_FORMAT, 'last4')).toBe(`${DRIVER_LICENCE_MASK_V1} 3456`)
    expect(maskDriverLicenceV1('99-12-34 56 7a', 'last4')).toBe(`${DRIVER_LICENCE_MASK_V1} 567A`)
  })

  it('treats any view other than exact full as last4 (fail closed)', () => {
    for (const view of [undefined, null, '', 'FULL', 'Full', ' full', 'full ', 'admin', 'Администратор', 1, true, {}, ['full']]) {
      const shown = maskDriverLicenceV1(NEW_FORMAT, view)
      expect(shown).toBe(`${DRIVER_LICENCE_MASK_V1} 5678`)
    }
  })

  it('never reveals more than four characters of the licence when masked', () => {
    for (const stored of [NEW_FORMAT, OLD_FORMAT, '9912345678', '1234567', 'AB12', '12345678901234567890']) {
      const shown = maskDriverLicenceV1(stored, 'last4') ?? ''
      const revealed = shown.replace(DRIVER_LICENCE_MASK_V1, '').replace(/\s/gu, '')
      expect(revealed.length).toBeLessThanOrEqual(4)
      expect(shown).not.toContain(driverLicenceKeyV1(stored)!.slice(0, 5))
    }
  })

  it('fully masks a stored value too short to keep four characters hidden', () => {
    expect(maskDriverLicenceV1('1234567', 'last4')).toBe(DRIVER_LICENCE_MASK_V1)
    expect(maskDriverLicenceV1('AB 12', 'last4')).toBe(DRIVER_LICENCE_MASK_V1)
    expect(maskDriverLicenceV1('--', 'last4')).toBe(DRIVER_LICENCE_MASK_V1)
    expect(maskDriverLicenceV1('12345678', 'last4')).toBe(`${DRIVER_LICENCE_MASK_V1} 5678`)
  })

  it('answers null when nothing is stored', () => {
    for (const stored of [null, undefined, '', '   ', 42, {}]) {
      expect(maskDriverLicenceV1(stored, 'full')).toBeNull()
      expect(maskDriverLicenceV1(stored, 'last4')).toBeNull()
    }
  })
})

describe('driverLicenceKeyV1', () => {
  it('compares letters and digits only, upper case, Cyrillic included', () => {
    expect(driverLicenceKeyV1(' 77 ав 123-456 ')).toBe('77АВ123456')
    expect(driverLicenceKeyV1('99.12.345678')).toBe('9912345678')
    expect(driverLicenceKeyV1('ё')).toBe('Ё')
  })

  it('answers null for a value with no letters or digits', () => {
    expect(driverLicenceKeyV1(' - ')).toBeNull()
    expect(driverLicenceKeyV1(null)).toBeNull()
    expect(driverLicenceKeyV1(12)).toBeNull()
  })
})
