import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ownershipAdmission: vi.fn(),
  driverFindUnique: vi.fn(),
  driverFindFirst: vi.fn(),
  driverFindMany: vi.fn(),
  driverUpdate: vi.fn(),
  driverCreate: vi.fn(),
  driverUpdateMany: vi.fn(),
  contactFindUnique: vi.fn(),
  reconcile: vi.fn(),
  persistClusterConflict: vi.fn(),
  persistStandaloneConflict: vi.fn(),
  apiLogCreate: vi.fn(),
  connections: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) => operation({
      $queryRaw: mocks.queryRaw,
      driver: {
        findUnique: mocks.driverFindUnique,
        findFirst: mocks.driverFindFirst,
        findMany: mocks.driverFindMany,
        update: mocks.driverUpdate,
        create: mocks.driverCreate,
        updateMany: mocks.driverUpdateMany,
      },
      contact: { findUnique: mocks.contactFindUnique },
    })),
    apiLog: { create: mocks.apiLogCreate },
  },
}))

vi.mock('./yandex-connection-capability', () => ({
  listYandexConnectionCredentialsV1: mocks.connections,
}))

vi.mock('@/modules/contacts/public/v1', () => ({
  persistDriverClusterContradictionV1: mocks.persistStandaloneConflict,
  runDriverClusterContactOwnershipV1: async (work: (capability: unknown) => unknown) => {
    await mocks.ownershipAdmission()
    return work({
      reconcile: mocks.reconcile,
      persistContradiction: mocks.persistClusterConflict,
    })
  },
}))

import {
  reconcileClusters,
  refreshYandexFleetDriverProfileV1,
  upsertObservation,
  type YandexFleetProfileObservationV1,
} from '../../internal/legacy-prisma-yandex-fleet-reconciler-adapter'

function observation(overrides: Partial<YandexFleetProfileObservationV1> = {}): YandexFleetProfileObservationV1 {
  return {
    externalParkId: 'park-a',
    localParkId: 'local-a',
    sourceConnectionId: 'connection-a',
    externalDriverProfileId: 'profile-a',
    fullName: 'Driver A',
    phones: ['+79990000001'],
    rawPhones: ['+7 999 000-00-01'],
    rawVu: '12 34 567890',
    normalizedVu: '1234567890',
    legalRole: 'driver',
    workStatus: 'working',
    currentStatus: 'online',
    city: 'Москва',
    profileType: 'staff',
    sourceDates: {},
    observedAt: new Date('2026-09-02T00:00:00.000Z'),
    rawMetadata: {},
    evidenceRoot: 'yandex:park-a:profile-a:current',
    ...overrides,
  }
}

describe('durable multi-park reconciliation context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryRaw.mockResolvedValue([])
    mocks.ownershipAdmission.mockResolvedValue(undefined)
    mocks.persistClusterConflict.mockResolvedValue(undefined)
    mocks.driverUpdateMany.mockResolvedValue({ count: 0 })
  })

  test('loads a failed-park same-VU profile and defers an exact Contact pair to locked Contacts policy', async () => {
    mocks.driverFindMany.mockResolvedValueOnce([
      {
        id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
        sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
        licenseNumber: '12 34 567890', customFields: {
          fleetSource: { sourceFreshness: 'fresh', sourceState: 'current', sourcePhones: ['+79990000001'] },
        }, contactId: null, personResolutionStatus: 'vu_observed',
      },
      {
        id: 'driver-b', externalParkId: 'park-b', externalDriverProfileId: 'profile-b',
        sourceConnectionId: 'connection-b', fullName: 'Driver B', phone: '+79990000002',
        licenseNumber: '12 34 567890', customFields: {
          fleetSource: {
            sourceFreshness: 'stale', sourceState: 'stale', sourcePhones: ['+79990000002'],
            lastObservedAt: '2026-09-01T00:00:00.000Z',
          },
        }, contactId: 'contact-a', personResolutionStatus: 'operator_confirmed',
      },
    ])
    mocks.reconcile.mockResolvedValueOnce({ status: 'link', contactId: 'contact-b', basis: 'unique_phone' })

    const result = await reconcileClusters([{ driverId: 'driver-a', observation: observation() }])

    expect(mocks.driverFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalPersonKey: 'vu:1234567890' },
    }))
    expect(mocks.persistClusterConflict).not.toHaveBeenCalled()
    expect(mocks.driverUpdateMany).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({
      contactId: null,
      contactMergeCandidateIds: ['contact-a', 'contact-b'],
      profileIds: ['driver-a', 'driver-b'],
      warnings: ['contact_auto_merge_candidate'],
    })
  })

  test('re-reads a phone dispute only after CNT1 admission and does not link', async () => {
    let decision: { status: 'link'; contactId: string; basis: 'unique_phone' } | { status: 'conflict'; contactIds: string[] } = {
      status: 'link', contactId: 'contact-a', basis: 'unique_phone',
    }
    mocks.ownershipAdmission.mockImplementationOnce(async () => {
      decision = { status: 'conflict', contactIds: ['contact-a', 'contact-b'] }
    })
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockImplementationOnce(async () => decision)

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.ownershipAdmission.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reconcile.mock.invocationCallOrder[0])
    expect(mocks.driverUpdateMany).not.toHaveBeenCalled()
    expect(mocks.persistClusterConflict).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({
      contactId: null,
      contactMergeCandidateIds: ['contact-a', 'contact-b'],
      warnings: ['contact_auto_merge_candidate'],
    })
  })

  test('persists a contradiction rather than proposing automation for more than two Contacts', async () => {
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockResolvedValueOnce({
      status: 'conflict',
      contactIds: ['contact-c', 'contact-a', 'contact-b'],
    })

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.persistClusterConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactIds: ['contact-c', 'contact-a', 'contact-b'],
    }))
    expect(result[0]).toMatchObject({
      contactMergeCandidateIds: [],
      warnings: ['contact_phone_ambiguity'],
    })
  })

  test('uses the operator confirmation observed after CNT1 admission', async () => {
    let confirmedContactId = 'contact-old'
    mocks.ownershipAdmission.mockImplementationOnce(async () => {
      confirmedContactId = 'contact-new'
    })
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockImplementationOnce(async () => ({
      status: 'link', contactId: confirmedContactId, basis: 'operator_confirmation',
    }))
    mocks.contactFindUnique.mockResolvedValue({ isArchived: false, customFields: {} })

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.driverUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 'contact-new', personResolutionStatus: 'operator_confirmed' }),
    }))
    expect(result[0].contactId).toBe('contact-new')
  })

  test('an older pre-lock observation cannot overwrite newer profile evidence or trigger a stale cluster decision', async () => {
    mocks.driverFindUnique.mockResolvedValueOnce({
      id: 'driver-a',
      contactId: 'contact-new',
      yandexDriverId: 'qualified-a',
      licenseNumber: '1234567890',
      customFields: {
        fleetSource: {
          lastObservedAt: '2026-09-02T02:00:00.000Z',
          sourceFreshness: 'fresh',
          sourceState: 'current',
        },
      },
    })

    await expect(upsertObservation(observation({
      observedAt: new Date('2026-09-02T01:00:00.000Z'),
      phones: ['+79990000009'],
      normalizedVu: '9999999999',
      rawVu: '9999999999',
    }), 2)).resolves.toBeNull()

    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    expect(mocks.driverCreate).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})

describe('targeted refresh of one driver profile', () => {
  const PARK_A = 'a'.repeat(32)
  const PARK_B = 'b'.repeat(32)
  const PROFILE = 'c'.repeat(32)
  const fetchMock = vi.fn()
  const connection = (park: string, clid: string) => ({
    id: `conn-${clid}`, connectionId: `conn-${clid}`, clid, apiKey: `key-${clid}`, parkId: park, localParkId: `local-${clid}`, name: clid,
  })
  const profileRow = (id: string) => ({
    driver_profile: {
      id,
      first_name: 'Иван', last_name: 'Петров', phones: ['+79990000001'],
      work_status: 'working', created_date: '2026-10-19T05:00:00.000+0000',
      hire_date: '2026-10-19T05:00:00.000+0000', is_selfemployed: true, employment_type: 'selfemployed',
    },
    current_status: { status: 'free' },
  })
  const answer = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
    ok: status >= 200 && status < 300, status, headers: new Headers(headers), json: async () => body,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    mocks.connections.mockResolvedValue([connection(PARK_A, 'yoko'), connection(PARK_B, 'yoko2')])
    mocks.queryRaw.mockResolvedValue([{ admitted: true }])
    mocks.driverFindUnique.mockResolvedValue({ id: 'driver-1', contactId: 'contact-1', yandexDriverId: 'legacy', licenseNumber: null, customFields: {} })
    mocks.driverFindFirst.mockResolvedValue(null)
    mocks.driverUpdate.mockResolvedValue({ id: 'driver-1' })
    mocks.apiLogCreate.mockResolvedValue({})
  })

  test('asks exactly one profile of its own park, with that park\'s own credentials', async () => {
    fetchMock.mockResolvedValue(answer(200, { driver_profiles: [profileRow(PROFILE)], total: 1 }))
    await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_B, externalDriverProfileId: PROFILE })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://fleet-api.taxi.yandex.net/v1/parks/driver-profiles/list')
    expect(init.headers).toMatchObject({ 'X-Client-ID': 'yoko2', 'X-Api-Key': 'key-yoko2' })
    const body = JSON.parse(init.body)
    expect(body.query).toEqual({ park: { id: PARK_B, driver_profile: { id: [PROFILE] } } })
    expect(body.limit).toBe(1)
    expect(body.offset).toBe(0)
    expect(body.fields.driver_profile).toEqual(expect.arrayContaining(['id', 'hire_date', 'is_selfemployed', 'employment_type']))
  })

  test('stores the profile through the reconciler upsert and leaves identity alone', async () => {
    fetchMock.mockResolvedValue(answer(200, { driver_profiles: [profileRow(PROFILE)], total: 1 }))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_B, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'refreshed' })
    expect(mocks.driverFindUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalParkId_externalDriverProfileId: { externalParkId: PARK_B, externalDriverProfileId: PROFILE } },
    }))
    expect(mocks.driverUpdate).toHaveBeenCalledTimes(1)
    const { data } = mocks.driverUpdate.mock.calls[0][0]
    expect(data).toMatchObject({ isSelfEmployed: true, employmentType: 'selfemployed', externalParkId: PARK_B, externalDriverProfileId: PROFILE })
    expect(data.yandexHireDate).toEqual(new Date('2026-10-19T05:00:00.000Z'))
    // No cluster or contact pass, and no contact link written.
    expect(mocks.ownershipAdmission).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
    expect(data).not.toHaveProperty('contactId')
    expect(mocks.apiLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ connectionId: 'conn-yoko2', statusCode: 200, error: null }) })
  })

  test('writes nothing when Yandex answers with another profile, or with more than one', async () => {
    for (const rows of [[profileRow('d'.repeat(32))], [profileRow(PROFILE), profileRow('d'.repeat(32))], []]) {
      mocks.driverUpdate.mockClear()
      mocks.driverCreate.mockClear()
      fetchMock.mockResolvedValue(answer(200, { driver_profiles: rows, total: rows.length }))
      expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_B, externalDriverProfileId: PROFILE }))
        .toEqual({ status: 'not_returned' })
      expect(mocks.driverUpdate).not.toHaveBeenCalled()
      expect(mocks.driverCreate).not.toHaveBeenCalled()
    }
  })

  test('reports HTTP 429 with Retry-After and logs it like the nightly run', async () => {
    fetchMock.mockResolvedValue(answer(429, {}, { 'Retry-After': '30' }))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_A, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'rate_limited', retryAfterMs: 30_000 })
    expect(mocks.apiLogCreate).toHaveBeenCalledWith({ data: expect.objectContaining({ statusCode: 0, error: 'Yandex Fleet HTTP 429' }) })
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    fetchMock.mockResolvedValue(answer(429, {}))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_A, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'rate_limited', retryAfterMs: null })
  })

  test('fails closed on any other provider fault, without retrying inside the request', async () => {
    fetchMock.mockResolvedValue(answer(500, {}))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_A, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'failed', code: 'provider_error' })
    fetchMock.mockRejectedValue(new Error('network down'))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_A, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'failed', code: 'provider_error' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(mocks.driverUpdate).not.toHaveBeenCalled()
  })

  test('asks nothing for a park without its own connection', async () => {
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: 'e'.repeat(32), externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'failed', code: 'no_connection' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('fails closed when the store refuses the write', async () => {
    fetchMock.mockResolvedValue(answer(200, { driver_profiles: [profileRow(PROFILE)], total: 1 }))
    mocks.driverUpdate.mockRejectedValue(new Error('lock timeout'))
    expect(await refreshYandexFleetDriverProfileV1({ externalParkId: PARK_B, externalDriverProfileId: PROFILE }))
      .toEqual({ status: 'failed', code: 'persist_failed' })
  })
})
