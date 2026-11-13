import { describe, expect, it } from 'vitest'

import {
  DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1,
  DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1,
  DriverProfilesByExactLicenceQueryValidationError,
  parseDriverProfilesByExactLicenceQueryV1,
} from './driver-profiles-by-exact-licence-query'

const LICENCE = '99 12 345678'
const valid = { contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence: LICENCE, licenceView: 'last4' }

function refusal(input: unknown): DriverProfilesByExactLicenceQueryValidationError {
  try {
    parseDriverProfilesByExactLicenceQueryV1(input)
  } catch (error) {
    expect(error).toBeInstanceOf(DriverProfilesByExactLicenceQueryValidationError)
    return error as DriverProfilesByExactLicenceQueryValidationError
  }
  throw new Error('expected a refusal')
}

describe('parseDriverProfilesByExactLicenceQueryV1', () => {
  it('accepts a typed licence with an explicit view', () => {
    expect(parseDriverProfilesByExactLicenceQueryV1(valid)).toEqual(valid)
    expect(parseDriverProfilesByExactLicenceQueryV1({ ...valid, licenceView: 'full' }).licenceView).toBe('full')
  })

  it('requires the licence view: there is no default', () => {
    const { licenceView: _omitted, ...withoutView } = valid
    expect(refusal(withoutView).code).toBe('INVALID_CONTRACT')
    for (const licenceView of [null, '', 'FULL', 'Администратор', 0]) {
      expect(refusal({ ...valid, licenceView }).code).toBe('INVALID_CONTRACT')
    }
  })

  it('refuses unknown fields, other versions and an over-long value', () => {
    expect(refusal({ ...valid, role: 'Администратор' }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, contract: 'fleet_operations.DriverProfilesByExactLicenceQuery.v2' }).code).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(refusal({ ...valid, contract: 'x' }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, licence: 9912345678 }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, licence: '9'.repeat(DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1 + 1) }).code).toBe('INVALID_CONTRACT')
  })

  it('never echoes the typed licence in a refusal', () => {
    const typed = '7799 000111'
    const refusals = [
      refusal({ ...valid, licence: typed, licenceView: 'admin' }),
      refusal({ ...valid, licence: typed, extra: typed }),
      refusal({ ...valid, licence: typed, contract: 'fleet_operations.DriverProfilesByExactLicenceQuery.v9' }),
      refusal({ ...valid, licence: `${typed}${'0'.repeat(DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_INPUT_V1)}` }),
    ]
    for (const error of refusals) {
      expect(error.message).not.toContain('7799')
      expect(error.message).not.toContain('000111')
    }
  })
})
