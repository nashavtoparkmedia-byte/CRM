import { describe, expect, it } from 'vitest'
import {
  DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1,
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  DriverProfilesForContactsQueryValidationError,
  parseDriverProfilesForContactsQueryV1,
} from './driver-profiles-for-contacts-query'

const valid = {
  contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }],
}

describe('parseDriverProfilesForContactsQueryV1', () => {
  it('accepts exact subjects and normalizes an absent legacy link to null', () => {
    const parsed = parseDriverProfilesForContactsQueryV1({
      contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
      subjects: [{ contactId: 'contact-a' }, { contactId: 'contact-b', legacyYandexDriverId: 'yd-1' }],
    })
    expect(parsed.subjects).toEqual([
      { contactId: 'contact-a', legacyYandexDriverId: null },
      { contactId: 'contact-b', legacyYandexDriverId: 'yd-1' },
    ])
  })

  it('rejects a wrong or unsupported contract version', () => {
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, contract: 'x' }))
      .toThrow(DriverProfilesForContactsQueryValidationError)
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, contract: 'fleet_operations.DriverProfilesForContactsQuery.v2' }))
      .toThrow(/unsupported contract version/)
  })

  it('rejects extra fields on the query and on a subject', () => {
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, phone: '+7' })).toThrow(/unsupported field/)
    expect(() => parseDriverProfilesForContactsQueryV1({
      contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
      subjects: [{ contactId: 'a', driverId: 'd' }],
    })).toThrow(/unsupported subject field/)
  })

  it('rejects padded, empty, duplicate and too many subjects', () => {
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: [] })).toThrow(/non-empty/)
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: [{ contactId: ' a' }] })).toThrow(/exact/)
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: [{ contactId: '' }] })).toThrow(/exact/)
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: [{ contactId: 'a' }, { contactId: 'a' }] }))
      .toThrow(/distinct/)
    expect(() => parseDriverProfilesForContactsQueryV1({
      ...valid,
      subjects: Array.from({ length: DRIVER_PROFILES_FOR_CONTACTS_MAX_CONTACTS_V1 + 1 }, (_, i) => ({ contactId: `c${i}` })),
    })).toThrow(/not exceed/)
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: [{ contactId: 'a', legacyYandexDriverId: ' y' }] }))
      .toThrow(/legacyYandexDriverId/)
  })

  it('does not accept a bare contact id, a phone or a name as the subject', () => {
    expect(() => parseDriverProfilesForContactsQueryV1({ ...valid, subjects: ['contact-a'] })).toThrow(/object/)
    expect(() => parseDriverProfilesForContactsQueryV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, phone: '+79990000000' }))
      .toThrow(/unsupported field/)
  })
})
