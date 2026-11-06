import { describe, expect, it } from 'vitest'
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1,
} from '../../../../contracts/fleet-operations/v1'
import {
  createDriverProfilesForContactsHandlerV1,
  type DriverProfileRowV1,
} from './driver-profiles-for-contacts-handler'

function row(overrides: Partial<DriverProfileRowV1> & { id: string }): DriverProfileRowV1 {
  return {
    contactId: null,
    yandexDriverId: null,
    externalParkId: 'park-1',
    externalDriverProfileId: `profile-${overrides.id}`,
    parkName: 'Парк 1',
    fullName: 'Иванов Иван',
    personResolutionStatus: 'vu_clustered',
    personKeyType: 'normalized_vu',
    customFields: { fleetSource: { sourceFreshness: 'fresh', sourceState: 'current', lastObservedAt: '2026-11-01T00:00:00.000Z', workStatus: 'working', legalRole: 'selfemployed' } },
    segment: 'active',
    dismissedAt: null,
    ...overrides,
  }
}

function handlerWith(rows: DriverProfileRowV1[], seen: Array<{ contactIds: readonly string[]; yandexDriverIds: readonly string[] }> = []) {
  return createDriverProfilesForContactsHandlerV1({
    async findDriverProfiles(input) {
      seen.push(input)
      return rows
    },
  })
}

describe('readDriverProfilesForContactsV1', () => {
  it('returns one entry per subject in the asked order, with profiles sorted by park', async () => {
    const rows = [
      row({ id: 'd3', contactId: 'c1', parkName: 'Парк Б', externalParkId: 'park-b' }),
      row({ id: 'd1', contactId: 'c1', parkName: 'Парк А', externalParkId: 'park-a' }),
      row({ id: 'd2', contactId: 'c1', parkName: 'Парк А', externalParkId: 'park-a', externalDriverProfileId: 'profile-0' }),
      row({ id: 'd9', contactId: 'other' }),
    ]
    const result = await handlerWith(rows)({
      contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
      subjects: [{ contactId: 'c2' }, { contactId: 'c1' }],
    })
    expect(result.contract).toBe(DRIVER_PROFILES_FOR_CONTACTS_RESULT_V1)
    expect(result.entries.map(entry => entry.contactId)).toEqual(['c2', 'c1'])
    expect(result.entries[0].profiles).toEqual([])
    expect(result.entries[1].profiles.map(profile => profile.driverId)).toEqual(['d2', 'd1', 'd3'])
    expect(result.entries[1].profiles.every(profile => profile.linkBasis === 'contact_link')).toBe(true)
  })

  it('matches the legacy Yandex link only for the subject that holds it and reports the basis', async () => {
    const rows = [
      row({ id: 'legacy', contactId: null, yandexDriverId: 'yd-1' }),
      row({ id: 'both', contactId: 'c1', yandexDriverId: 'yd-1' }),
    ]
    const seen: Array<{ contactIds: readonly string[]; yandexDriverIds: readonly string[] }> = []
    const result = await handlerWith(rows, seen)({
      contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
      subjects: [{ contactId: 'c1', legacyYandexDriverId: 'yd-1' }, { contactId: 'c2', legacyYandexDriverId: null }],
    })
    expect(seen).toEqual([{ contactIds: ['c1', 'c2'], yandexDriverIds: ['yd-1'] }])
    expect(result.entries[0].profiles.map(profile => [profile.driverId, profile.linkBasis])).toEqual([
      ['both', 'both'],
      ['legacy', 'legacy_yandex_link'],
    ])
    expect(result.entries[1].profiles).toEqual([])
  })

  it('projects Fleet evidence into bounded fields and never a licence number', async () => {
    const result = await handlerWith([
      row({ id: 'd1', contactId: 'c1', personResolutionStatus: 'operator_confirmed', dismissedAt: new Date('2026-10-01T00:00:00Z') }),
      row({ id: 'd2', contactId: 'c1', personResolutionStatus: 'something_new', customFields: null, parkName: null, personKeyType: null }),
    ])({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: [{ contactId: 'c1' }] })
    const [confirmed, unknown] = result.entries[0].profiles.sort((a, b) => a.driverId.localeCompare(b.driverId))
    expect(confirmed).toMatchObject({
      personResolutionStatus: 'operator_confirmed',
      personKeyType: 'normalized_vu',
      sourceFreshness: 'fresh',
      sourceState: 'current',
      lastObservedAt: '2026-11-01T00:00:00.000Z',
      workStatus: 'working',
      legalRole: 'selfemployed',
      dismissedAt: '2026-10-01T00:00:00.000Z',
    })
    expect(unknown).toMatchObject({
      personResolutionStatus: 'unknown',
      personKeyType: null,
      parkName: null,
      sourceFreshness: 'unknown',
      sourceState: 'unknown',
      lastObservedAt: null,
    })
    for (const profile of result.entries[0].profiles) {
      expect(Object.keys(profile)).not.toContain('licenseNumber')
      expect(Object.keys(profile)).not.toContain('externalPersonKey')
      expect(Object.keys(profile)).not.toContain('phone')
    }
  })

  it('refuses an invalid query before reading', async () => {
    const seen: unknown[] = []
    const handler = handlerWith([], seen as never)
    await expect(handler({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: [] })).rejects.toThrow(/non-empty/)
    await expect(handler({ contract: 'x', subjects: [{ contactId: 'c1' }] })).rejects.toThrow(/contract/)
    expect(seen).toEqual([])
  })
})
