import { describe, expect, it } from 'vitest'

import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3,
  driverEmploymentTypeV3,
  DriverProfilesForContactsQueryV3ValidationError,
  parseDriverProfilesForContactsQueryV3,
} from './driver-profiles-for-contacts-query'

const subjects = [{ contactId: 'contact-a', legacyYandexDriverId: null }]
const valid = { contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, licenceView: 'last4', subjects }

function refusal(input: unknown): DriverProfilesForContactsQueryV3ValidationError {
  try {
    parseDriverProfilesForContactsQueryV3(input)
  } catch (error) {
    expect(error).toBeInstanceOf(DriverProfilesForContactsQueryV3ValidationError)
    return error as DriverProfilesForContactsQueryV3ValidationError
  }
  throw new Error('expected a refusal')
}

describe('parseDriverProfilesForContactsQueryV3', () => {
  it('accepts v2\'s query under the v3 contract, with an explicit view', () => {
    expect(parseDriverProfilesForContactsQueryV3(valid)).toEqual(valid)
    expect(parseDriverProfilesForContactsQueryV3({ ...valid, licenceView: 'full' }).licenceView).toBe('full')
  })

  it('requires the licence view and refuses unknown fields, other versions and bad subjects', () => {
    const { licenceView: _omitted, ...withoutView } = valid
    expect(refusal(withoutView).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, licenceView: 'FULL' }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, phone: true }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, subjects: [] }).code).toBe('INVALID_CONTRACT')
    expect(refusal({ ...valid, contract: 'fleet_operations.DriverProfilesForContactsQuery.v2' }).code).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(refusal({ ...valid, contract: 'fleet_operations.DriverProfilesForContactsQuery.v9' }).message).not.toContain('v9')
    expect(refusal(null).code).toBe('INVALID_CONTRACT')
  })
})

describe('driverEmploymentTypeV3', () => {
  it('passes the three known codes and maps any other stored value to unknown', () => {
    expect(driverEmploymentTypeV3('park_employee')).toBe('park_employee')
    expect(driverEmploymentTypeV3('selfemployed')).toBe('selfemployed')
    expect(driverEmploymentTypeV3('individual_entrepreneur')).toBe('individual_entrepreneur')
    for (const stored of ['unknown', 'Park_Employee', 'self_employed', 'partner', 'work_rule_7f3a', ' park_employee']) {
      expect(driverEmploymentTypeV3(stored)).toBe('unknown')
    }
  })

  it('is null when nothing is stored', () => {
    for (const stored of [null, undefined, '', '   ']) expect(driverEmploymentTypeV3(stored)).toBeNull()
    expect(driverEmploymentTypeV3(42)).toBeNull()
  })
})
