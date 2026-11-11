import { describe, expect, it } from 'vitest'

import {
  DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1,
  DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1,
  DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1,
} from '../../../../contracts/fleet-operations/v1'
import { DRIVER_LICENCE_MASK_V1 } from './driver-licence-mask'
import type { DriverLicenceProfileRowV1 } from './driver-licence-read-port'
import { createDriverProfilesByExactLicenceHandlerV1 } from './driver-profiles-by-exact-licence-handler'

const STORED = '99 12 345678'

function row(index: number, overrides: Partial<DriverLicenceProfileRowV1> = {}): DriverLicenceProfileRowV1 {
  return {
    id: `driver-${index}`,
    contactId: `contact-${index}`,
    externalParkId: 'park-1',
    externalDriverProfileId: `profile-${index}`,
    parkName: 'Park One',
    fullName: `Водитель ${index}`,
    licenseNumber: STORED,
    dismissedAt: null,
    ...overrides,
  }
}

function setup(rows: DriverLicenceProfileRowV1[]) {
  const calls: Array<{ key: string; limit: number }> = []
  const handler = createDriverProfilesByExactLicenceHandlerV1({
    async findProfilesByLicenceKey(key, limit) { calls.push({ key, limit }); return rows.slice(0, limit) },
  })
  return { handler, calls }
}

const query = (licence: unknown, licenceView: unknown) => ({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_QUERY_V1, licence, licenceView })

describe('findDriverProfilesByExactLicenceV1', () => {
  it('searches by the licence key, however it was typed', async () => {
    const { handler, calls } = setup([row(1)])
    await handler(query(' 99-12 34 56 78 ', 'last4'))
    await handler(query('77 ав 123456', 'last4'))
    expect(calls).toEqual([
      { key: '9912345678', limit: DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 + 1 },
      { key: '77АВ123456', limit: DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 + 1 },
    ])
  })

  it('shows the stored licence in full only for the full view', async () => {
    const { handler } = setup([row(1, { dismissedAt: new Date('2026-01-02T03:04:05.000Z') })])
    const result = await handler(query('9912345678', 'full'))
    expect(result).toEqual({
      contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1,
      profiles: [{
        driverId: 'driver-1',
        linkedContactId: 'contact-1',
        externalParkId: 'park-1',
        externalDriverProfileId: 'profile-1',
        parkName: 'Park One',
        fullName: 'Водитель 1',
        licence: STORED,
        dismissedAt: '2026-01-02T03:04:05.000Z',
      }],
      truncated: false,
    })
  })

  it('never echoes the typed licence, nor the stored one, for last4', async () => {
    const { handler } = setup([row(1), row(2, { licenseNumber: '99-12-345678' })])
    const result = await handler(query('9912345678', 'last4'))
    expect(result.profiles.map(profile => profile.licence)).toEqual([`${DRIVER_LICENCE_MASK_V1} 5678`, `${DRIVER_LICENCE_MASK_V1} 5678`])
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('9912345678')
    expect(serialized).not.toContain('345678')
    expect(serialized).not.toContain('99 12')
    expect(Object.keys(result).sort()).toEqual(['contract', 'profiles', 'truncated'])
  })

  it('reads nothing for a value that is not a licence', async () => {
    const { handler, calls } = setup([row(1)])
    for (const licence of ['', '   ', '12345', 'АВ-12', '--------']) {
      expect(await handler(query(licence, 'full'))).toEqual({ contract: DRIVER_PROFILES_BY_EXACT_LICENCE_RESULT_V1, profiles: [], truncated: false })
    }
    expect(calls).toEqual([])
  })

  it('reads nothing when the view is missing or unknown', async () => {
    const { handler, calls } = setup([row(1)])
    for (const view of [undefined, null, 'FULL', 'Администратор']) {
      await expect(handler(query('9912345678', view))).rejects.toThrow(/licenceView/)
    }
    expect(calls).toEqual([])
  })

  it('is bounded and says when more matched', async () => {
    const many = Array.from({ length: DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1 + 5 }, (_, i) => row(i))
    const { handler } = setup(many)
    const result = await handler(query('9912345678', 'last4'))
    expect(result.profiles).toHaveLength(DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1)
    expect(result.truncated).toBe(true)
    const exact = setup(many.slice(0, DRIVER_PROFILES_BY_EXACT_LICENCE_MAX_PROFILES_V1))
    expect((await exact.handler(query('9912345678', 'last4'))).truncated).toBe(false)
  })
})
