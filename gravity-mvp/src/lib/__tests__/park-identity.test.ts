import { describe, expect, test } from 'vitest'
import {
  APPROVED_PARKS,
  buildCompositeDriverProfileKey,
  chooseMainParkIdentityProfile,
  dedupeSourceDriverProfiles,
  reconcileParkIdentity,
  resolveParkConnectionMappings,
  type MainProfileSource,
  type SourceDriverProfile,
} from '../driver-profiles/park-identity'
import { buildInventorySnapshot, retryDelayMs, sanitizeYandexProfile } from '../driver-profiles/park-inventory'

function source(overrides: Partial<SourceDriverProfile> = {}): SourceDriverProfile {
  return {
    externalParkId: '45e30e9d6b824c608e5d28719cb19a6e',
    externalDriverProfileId: 'profile-1',
    parkCode: 'NASH_AVTOPARK',
    parkName: '\u041d\u0430\u0448 \u0410\u0432\u0442\u043e\u043f\u0430\u0440\u043a',
    phone: '+79990000000',
    fullName: 'Driver One',
    sourceWorkStatus: 'working',
    sourceCurrentStatus: 'offline',
    sourceUpdatedAt: '2026-07-01T00:00:00.000Z',
    fetchedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}
function mainProfile(overrides: Partial<MainProfileSource> = {}): MainProfileSource {
  return {
    id: 'profile',
    parkCode: 'YOKO',
    status: 'working',
    externalDriverProfileId: 'profile',
    ...overrides,
  }
}

describe('stable park identity model', () => {
  test('all six approved park codes map by externalParkId regardless of connection order', () => {
    const shuffled = [...APPROVED_PARKS]
      .reverse()
      .map((park, index) => ({ id: `conn-${index}`, parkId: park.externalParkId, name: `name-${index}` }))
    const result = resolveParkConnectionMappings(shuffled)
    expect(result.errors).toEqual([])
    expect(result.mappings.map(item => item.parkCode)).toEqual(['NASH_AVTOPARK', 'YOKO', 'YOKO_2', 'YOKO_3', 'YOKO_4', 'YOKO_DELIVERY'])
  })

  test('unknown connection and duplicate park mapping are explicit errors', () => {
    const result = resolveParkConnectionMappings([
      { id: 'conn-a', parkId: APPROVED_PARKS[0].externalParkId },
      { id: 'conn-b', parkId: APPROVED_PARKS[0].externalParkId },
      { id: 'conn-z', parkId: 'unknown-park' },
    ])
    expect(result.errors.join('\n')).toContain('unknown Yandex ApiConnection parkId unknown-park')
    expect(result.errors.join('\n')).toContain('parkCode NASH_AVTOPARK is mapped more than once')
    expect(result.errors.join('\n')).toContain('missing ApiConnection mapping for YOKO')
  })

  test('composite identity allows same profile id and same phone in different parks', () => {
    const rows = [
      source({ externalParkId: APPROVED_PARKS[0].externalParkId, parkCode: 'NASH_AVTOPARK', externalDriverProfileId: 'same', phone: '+79990000000' }),
      source({ externalParkId: APPROVED_PARKS[1].externalParkId, parkCode: 'YOKO', parkName: 'YOKO', externalDriverProfileId: 'same', phone: '+79990000000' }),
    ]
    const deduped = dedupeSourceDriverProfiles(rows)
    expect(deduped.profiles).toHaveLength(2)
    expect(deduped.profiles.map(row => buildCompositeDriverProfileKey(row.externalParkId, row.externalDriverProfileId))).toEqual([
      `${APPROVED_PARKS[0].externalParkId}:same`,
      `${APPROVED_PARKS[1].externalParkId}:same`,
    ])
  })

  test('repeat source payload in one park is deduped and inventory stays idempotent', () => {
    const rows = [source(), source({ sourceUpdatedAt: '2026-07-02T00:00:00.000Z' })]
    const first = dedupeSourceDriverProfiles(rows)
    const second = dedupeSourceDriverProfiles(first.profiles)
    expect(first.profiles).toHaveLength(1)
    expect(first.duplicates).toEqual([{ key: `${APPROVED_PARKS[0].externalParkId}:profile-1`, count: 2 }])
    expect(second.profiles).toEqual(first.profiles)
  })

  test('reconciliation matches by stable external id only and reports phone multi-park as non-blocking', () => {
    const profiles = [
      source({ externalParkId: APPROVED_PARKS[0].externalParkId, parkCode: 'NASH_AVTOPARK', externalDriverProfileId: 'legacy-a', phone: '+79990000000' }),
      source({ externalParkId: APPROVED_PARKS[1].externalParkId, parkCode: 'YOKO', parkName: 'YOKO', externalDriverProfileId: 'legacy-b', phone: '+79990000000' }),
    ]
    const result = reconcileParkIdentity([
      { id: 'driver-a', yandexDriverId: 'legacy-a', phone: '+79990000000', fullName: 'Name A' },
    ], profiles)
    expect(result.exactMatches).toEqual([{ legacyDriverId: 'driver-a', key: `${APPROVED_PARKS[0].externalParkId}:legacy-a` }])
    expect(result.sourceOnly.map(item => item.externalDriverProfileId)).toEqual(['legacy-b'])
    expect(result.phoneMultiPark).toHaveLength(1)
    expect(result.collisions).toEqual([])
  })

  test('incomplete source never classifies missing legacy rows as orphaned', () => {
    const result = reconcileParkIdentity([
      { id: 'driver-a', yandexDriverId: 'missing' },
    ], [], ['YOKO'])
    expect(result.incompleteSource).toBe(true)
    expect(result.legacyOnly).toEqual([])
  })

  test('name and phone do not assign park identity when external id is absent', () => {
    const result = reconcileParkIdentity([
      { id: 'driver-a', yandexDriverId: 'not-in-source', phone: '+79990000000', fullName: 'Same Name' },
    ], [source({ externalDriverProfileId: 'different', phone: '+79990000000', fullName: 'Same Name' })])
    expect(result.exactMatches).toEqual([])
    expect(result.sourceOnly).toHaveLength(1)
    expect(result.legacyOnly).toHaveLength(1)
  })

  test('main profile selection is deterministic and flags same-park active anomaly', () => {
    const selection = chooseMainParkIdentityProfile([
      mainProfile({ id: 'late', parkCode: 'YOKO', externalDriverProfileId: 'z' }),
      mainProfile({ id: 'manual', parkCode: 'YOKO_4', externalDriverProfileId: 'm', manual: true }),
      mainProfile({ id: 'dismissed', parkCode: 'NASH_AVTOPARK', status: 'dismissed', externalDriverProfileId: 'a' }),
    ].reverse())
    expect(selection.main?.id).toBe('manual')
    expect(selection.reason).toBe('manual')

    const anomaly = chooseMainParkIdentityProfile([
      mainProfile({ id: 'a', parkCode: 'YOKO', externalDriverProfileId: 'a' }),
      mainProfile({ id: 'b', parkCode: 'YOKO', externalDriverProfileId: 'b' }),
      mainProfile({ id: 'c', parkCode: 'YOKO_2', externalDriverProfileId: 'c' }),
    ])
    expect(anomaly.anomalies).toEqual([{ parkCode: 'YOKO', activeCount: 2, profileIds: ['a', 'b'] }])
    expect(anomaly.main?.id).toBe('c')
  })
})

describe('park inventory helpers', () => {
  test('retry delay honors Retry-After and otherwise adds bounded jitter', () => {
    expect(retryDelayMs(1, '5', () => 0.99)).toBe(5000)
    expect(retryDelayMs(3, null, () => 0)).toBe(4000)
    expect(retryDelayMs(3, null, () => 0.5)).toBe(4500)
  })

  test('sanitized snapshot removes raw secrets and unnecessary payload fields', () => {
    const sanitized = sanitizeYandexProfile({
      externalParkId: APPROVED_PARKS[0].externalParkId,
      parkCode: 'NASH_AVTOPARK',
      parkName: '\u041d\u0430\u0448 \u0410\u0432\u0442\u043e\u043f\u0430\u0440\u043a',
      fetchedAt: '2026-07-13T00:00:00.000Z',
      payload: {
        driver_profile: { id: 'profile-1', first_name: 'Ivan', last_name: 'Driver', phones: ['+79990000000'], work_status: 'working', secret: 'drop-me' },
        current_status: { status: 'offline', status_updated_at: '2026-07-01T00:00:00.000Z' },
      },
    })
    expect(sanitized).toMatchObject({ externalDriverProfileId: 'profile-1', fullName: 'Driver Ivan', phone: '+79990000000' })
    expect(JSON.stringify(sanitized)).not.toContain('drop-me')
  })

  test('inventory snapshot reports incomplete parks and preserves writes=false', () => {
    const snapshot = buildInventorySnapshot({
      connections: APPROVED_PARKS.map((park, index) => ({ id: `conn-${index}`, parkId: park.externalParkId })),
      pages: [
        { parkCode: 'NASH_AVTOPARK', requestedStatus: 'working', offset: 0, completed: true, rows: [source()], retries: 1, rateLimitCount: 1, errors: [] },
        { parkCode: 'YOKO', requestedStatus: 'working', offset: 0, completed: false, rows: [], retries: 8, rateLimitCount: 8, errors: ['retry budget exhausted'] },
      ],
      legacyDrivers: [{ id: 'driver-a', yandexDriverId: 'profile-1' }],
      generatedAt: '2026-07-13T00:00:00.000Z',
    })
    expect(snapshot.writes).toBe(false)
    expect(snapshot.connections.find(item => item.parkCode === 'YOKO')?.status).toBe('INCOMPLETE')
    expect(snapshot.reconciliation?.incompleteSource).toBe(true)
    expect(snapshot.reconciliation?.legacyOnly).toEqual([])
  })
})
