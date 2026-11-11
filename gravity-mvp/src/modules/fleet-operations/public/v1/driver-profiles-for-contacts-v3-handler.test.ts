import { describe, expect, it } from 'vitest'

import type { DriverProfilesForContactsQueryV2, DriverProfilesForContactsResultV2 } from '../../../../contracts/fleet-operations/v2'
import { DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2 } from '../../../../contracts/fleet-operations/v2'
import { DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3 } from '../../../../contracts/fleet-operations/v3'
import type { DriverCardFieldsRowV1 } from './driver-card-fields-read-port'
import { createDriverProfilesForContactsHandlerV3 } from './driver-profiles-for-contacts-v3-handler'

function v2Profile(driverId: string, licence: string | null) {
  return {
    driverId,
    linkedContactId: 'contact-a',
    externalParkId: 'park-1',
    externalDriverProfileId: `profile-${driverId}`,
    parkName: 'Park One',
    fullName: 'Иванов Иван',
    personResolutionStatus: 'vu_clustered',
    personKeyType: 'normalized_vu',
    workStatus: 'working',
    currentStatus: null,
    segment: 'active',
    dismissedAt: null,
    licence,
  } as unknown as DriverProfilesForContactsResultV2['entries'][number]['profiles'][number]
}

function setup(fields: Record<string, DriverCardFieldsRowV1>) {
  const v2Queries: DriverProfilesForContactsQueryV2[] = []
  const asked: string[][] = []
  const v2Result = (licenceView: 'full' | 'last4'): DriverProfilesForContactsResultV2 => ({
    contract: DRIVER_PROFILES_FOR_CONTACTS_RESULT_V2,
    licenceView,
    entries: [{ contactId: 'contact-a', profiles: [v2Profile('d1', '•••• 5678'), v2Profile('d2', null), v2Profile('d3', '•••• 0001')] }],
  })
  const handler = createDriverProfilesForContactsHandlerV3(
    async (query) => { v2Queries.push(query); return v2Result(query.licenceView) },
    { async findCardFieldsOfDrivers(ids) { asked.push([...ids]); return new Map(ids.filter(id => fields[id]).map(id => [id, fields[id]])) } },
  )
  return { handler, v2Queries, asked, v2Result }
}

const query = (licenceView: unknown) => ({ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V3, licenceView, subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }] })

describe('readDriverProfilesForContactsV3', () => {
  it('answers v2 unchanged plus the phone and the narrowed employment', async () => {
    const { handler, v2Queries, v2Result } = setup({
      d1: { phone: '+79991234567', isSelfEmployed: true, employmentType: 'selfemployed' },
      d2: { phone: '+998901234567', isSelfEmployed: false, employmentType: 'park_employee' },
      d3: { phone: '   ', isSelfEmployed: null, employmentType: 'work_rule_7f3a' },
    })
    const result = await handler(query('last4'))
    expect(v2Queries).toEqual([{ contract: DRIVER_PROFILES_FOR_CONTACTS_QUERY_V2, licenceView: 'last4', subjects: [{ contactId: 'contact-a', legacyYandexDriverId: null }] }])
    expect(result.contract).toBe(DRIVER_PROFILES_FOR_CONTACTS_RESULT_V3)
    expect(result.licenceView).toBe('last4')
    expect(result.entries[0].profiles.map(({ phone: _p, isSelfEmployed: _s, employmentType: _e, ...rest }) => rest)).toEqual(v2Result('last4').entries[0].profiles)
    expect(result.entries[0].profiles.map(p => [p.driverId, p.phone, p.isSelfEmployed, p.employmentType])).toEqual([
      ['d1', '+79991234567', true, 'selfemployed'],
      ['d2', '+998901234567', false, 'park_employee'],
      ['d3', null, null, 'unknown'],
    ])
  })

  it('a profile Fleet holds no card fields for gets nulls, never a guess', async () => {
    const { handler } = setup({})
    const result = await handler(query('full'))
    expect(result.entries[0].profiles.every(p => p.phone === null && p.isSelfEmployed === null && p.employmentType === null)).toBe(true)
  })

  it('never passes a raw provider value or a non-boolean flag', async () => {
    const { handler } = setup({ d1: { phone: '+79991234567', isSelfEmployed: 'yes' as unknown as boolean, employmentType: 'PARK_EMPLOYEE' } })
    const [profile] = (await handler(query('last4'))).entries[0].profiles
    expect(profile.isSelfEmployed).toBeNull()
    expect(profile.employmentType).toBe('unknown')
    expect(JSON.stringify(profile)).not.toContain('PARK_EMPLOYEE')
  })

  it('reads nothing when the view is missing or unknown', async () => {
    for (const view of [undefined, 'FULL', 'admin', null]) {
      const { handler, v2Queries, asked } = setup({})
      await expect(handler(query(view))).rejects.toThrow(/licenceView/)
      expect(v2Queries).toEqual([])
      expect(asked).toEqual([])
    }
  })

  it('asks the card-fields port once, for exactly the answered profiles', async () => {
    const { handler, asked } = setup({})
    await handler(query('last4'))
    expect(asked).toEqual([['d1', 'd2', 'd3']])
  })
})
