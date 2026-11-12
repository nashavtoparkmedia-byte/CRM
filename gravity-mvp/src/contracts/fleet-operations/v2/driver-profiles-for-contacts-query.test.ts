import { describe, expect, it } from 'vitest'

import { DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1, DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1 } from '../v1'
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  DriverProfilesForContactsQueryV2ValidationError,
  parseDriverProfilesForContactsQueryV2,
} from './driver-profiles-for-contacts-query'

const valid = {
  contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  licenceView: 'last4',
  subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }],
}

function codeOf(input: unknown): string | null {
  try {
    parseDriverProfilesForContactsQueryV2(input)
    return null
  } catch (error) {
    expect(error).toBeInstanceOf(DriverProfilesForContactsQueryV2ValidationError)
    return (error as DriverProfilesForContactsQueryV2ValidationError).code
  }
}

describe('parseDriverProfilesForContactsQueryV2', () => {
  it('accepts v1 subjects with an explicit licence view', () => {
    expect(parseDriverProfilesForContactsQueryV2({
      ...valid,
      licenceView: 'full',
      subjects: [{ contactId: 'contact-a' }, { contactId: 'contact-b', legacyYandexDriverId: 'yd-1' }],
    })).toEqual({
      contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
      licenceView: 'full',
      subjects: [
        { contactId: 'contact-a', legacyYandexDriverId: null },
        { contactId: 'contact-b', legacyYandexDriverId: 'yd-1' },
      ],
    })
  })

  it('requires the licence view: there is no default', () => {
    const { licenceView: _omitted, ...withoutView } = valid
    expect(codeOf(withoutView)).toBe('INVALID_CONTRACT')
    for (const licenceView of [null, '', 'FULL', 'admin', 'last-4', 4, true]) {
      expect(codeOf({ ...valid, licenceView })).toBe('INVALID_CONTRACT')
    }
  })

  it('refuses the v1 id and other versions, and unknown fields', () => {
    expect(codeOf({ ...valid, contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1 })).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(codeOf({ ...valid, contract: 'fleet_operations.DriverProfilesForContactsQuery.v3' })).toBe('UNSUPPORTED_CONTRACT_VERSION')
    expect(codeOf({ ...valid, contract: 'x' })).toBe('INVALID_CONTRACT')
    expect(codeOf({ ...valid, role: 'Администратор' })).toBe('INVALID_CONTRACT')
    expect(codeOf({ ...valid, subjects: [{ contactId: 'a', licence: '9912345678' }] })).toBe('INVALID_CONTRACT')
  })

  it('keeps every v1 subject rule', () => {
    expect(codeOf({ ...valid, subjects: [] })).toBe('INVALID_CONTRACT')
    expect(codeOf({ ...valid, subjects: [{ contactId: ' a' }] })).toBe('INVALID_CONTRACT')
    expect(codeOf({ ...valid, subjects: [{ contactId: 'a' }, { contactId: 'a' }] })).toBe('INVALID_CONTRACT')
    expect(codeOf({
      ...valid,
      subjects: Array.from({ length: DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1 + 1 }, (_, i) => ({ contactId: `c${i}` })),
    })).toBe('INVALID_CONTRACT')
    expect(codeOf(null)).toBe('INVALID_CONTRACT')
  })
})
