import { describe, expect, it } from 'vitest'

import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1,
  type DriverProfilesForContactsQueryV1,
} from '../../../../contracts/fleet-operations/v1'
import {
  DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2,
} from '../../../../contracts/fleet-operations/v2'
import { DRIVER_LICENCE_MASK_V1 } from './driver-licence-mask'
import { createDriverProfilesForContactsHandlerV1, type DriverProfileRowV1 } from './driver-profiles-for-contacts-handler'
import { createDriverProfilesForContactsHandlerV2 } from './driver-profiles-for-contacts-v2-handler'

const FULL = '99 12 345678'

function row(overrides: Partial<DriverProfileRowV1>): DriverProfileRowV1 {
  return {
    id: 'driver-1',
    contactId: 'contact-a',
    yandexDriverId: 'yd-1',
    externalParkId: 'park-1',
    externalDriverProfileId: 'profile-1',
    parkName: 'Park One',
    fullName: 'Иванов Иван',
    personResolutionStatus: 'vu_clustered',
    personKeyType: 'normalized_vu',
    customFields: null,
    segment: 'active',
    dismissedAt: null,
    ...overrides,
  }
}

function setup(stored: Record<string, string | null>) {
  const rows = [row({}), row({ id: 'driver-2', externalParkId: 'park-2', parkName: 'Park Two', yandexDriverId: 'yd-2' })]
  const v1Queries: DriverProfilesForContactsQueryV1[] = []
  const asked: string[][] = []
  const readV1 = createDriverProfilesForContactsHandlerV1({ async findDriverProfiles() { return rows } })
  const handler = createDriverProfilesForContactsHandlerV2(
    async (query) => { v1Queries.push(query); return readV1(query) },
    { async findLicencesOfDrivers(ids) { asked.push([...ids]); return new Map(ids.map(id => [id, stored[id] ?? null])) } },
  )
  return { handler, readV1, v1Queries, asked }
}

const query = (licenceView: unknown) => ({
  contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2,
  licenceView,
  subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }],
})

describe('readDriverProfilesForContactsV2', () => {
  it('answers v1 plus the licence, in full only for the full view', async () => {
    const { handler, readV1 } = setup({ 'driver-1': FULL, 'driver-2': null })
    const result = await handler(query('full'))
    const v1 = await readV1({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }] })
    expect(result.contract).toBe(DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2)
    expect(result.licenceView).toBe('full')
    expect(result.entries.map(entry => entry.profiles.map(({ licence: _licence, ...rest }) => rest))).toEqual(v1.entries.map(entry => entry.profiles))
    expect(result.entries[0].profiles.map(profile => profile.licence)).toEqual([FULL, null])
  })

  it('never carries the full licence for last4 (Менеджер, Руководитель)', async () => {
    const { handler } = setup({ 'driver-1': FULL, 'driver-2': '77 АВ 123456' })
    const result = await handler(query('last4'))
    expect(result.entries[0].profiles.map(profile => profile.licence)).toEqual([`${DRIVER_LICENCE_MASK_V1} 5678`, `${DRIVER_LICENCE_MASK_V1} 3456`])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('345678')
    expect(serialized).not.toContain('123456')
    expect(serialized).not.toContain('9912')
  })

  it('reads nothing when the view is missing or unknown', async () => {
    for (const view of [undefined, 'FULL', 'admin', null]) {
      const { handler, v1Queries, asked } = setup({ 'driver-1': FULL })
      await expect(handler(query(view))).rejects.toThrow(/licenceView/)
      expect(v1Queries).toEqual([])
      expect(asked).toEqual([])
    }
  })

  it('asks the licence port once, for exactly the answered profiles', async () => {
    const { handler, v1Queries, asked } = setup({ 'driver-1': FULL })
    await handler(query('last4'))
    expect(v1Queries).toEqual([{ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V1, subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }] }])
    expect(asked).toEqual([['driver-1', 'driver-2']])
  })
})
