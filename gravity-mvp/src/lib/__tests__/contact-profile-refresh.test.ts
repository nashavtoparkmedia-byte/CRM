import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  syncFindUnique: vi.fn(),
  driverFindMany: vi.fn(),
  driverUpsert: vi.fn(),
  parkFindMany: vi.fn(),
  parkFindUnique: vi.fn(),
  parkUpdate: vi.fn(),
  lockAcquire: vi.fn(),
  lockRelease: vi.fn(),
  refreshMain: vi.fn(),
  opsLog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    syncStatus: { findUnique: mocks.syncFindUnique },
    driver: { findMany: mocks.driverFindMany, upsert: mocks.driverUpsert },
    parkConnection: {
      findMany: mocks.parkFindMany,
      findUnique: mocks.parkFindUnique,
      update: mocks.parkUpdate,
    },
  },
}))

vi.mock('@/lib/opsLog', () => ({ opsLog: mocks.opsLog }))

vi.mock('../driver-profiles/production-sync', () => ({
  DatabaseNightlySyncLock: class {
    acquire(key: string) {
      return mocks.lockAcquire(key)
    }

    release(key: string, outcome: unknown) {
      return mocks.lockRelease(key, outcome)
    }
  },
  buildDriverProfileMutation: vi.fn(),
  driverProfileParkRefreshLockKey: (externalParkId: string) => 'driver-profiles:park-refresh:' + externalParkId,
}))

vi.mock('../driver-profiles/multi-park', () => ({
  refreshContactMainDriver: mocks.refreshMain,
}))

import { refreshContactDriverProfiles } from '../driver-profiles/contact-profile-refresh'

const now = new Date('2026-07-17T12:00:00.000Z')
const attachedProfile = {
  externalParkId: 'park-ext-1',
  externalDriverProfileId: 'profile-1',
}
const staleConnection = {
  id: 'connection-1',
  parkId: 'park-1',
  apiConnectionId: 'api-1',
  externalParkId: 'park-ext-1',
  lastSuccessfulSyncAt: new Date(0),
  lastFailedSyncAt: null,
  park: { parkCode: 'NASH_AVTOPARK', parkName: 'Наш Автопарк' },
  apiConnection: { clid: 'client', apiKey: 'key' },
}

function okResponse() {
  return {
    ok: true,
    json: async () => ({ driver_profiles: [] }),
  } as Response
}

function reset(connection = staleConnection) {
  vi.clearAllMocks()
  mocks.driverFindMany.mockResolvedValue([attachedProfile])
  mocks.parkFindMany.mockResolvedValue([connection])
  mocks.parkFindUnique.mockResolvedValue({
    lastSuccessfulSyncAt: connection.lastSuccessfulSyncAt,
    lastFailedSyncAt: connection.lastFailedSyncAt,
  })
  mocks.parkUpdate.mockResolvedValue({})
  mocks.lockAcquire.mockResolvedValue(true)
  mocks.lockRelease.mockResolvedValue(undefined)
  mocks.refreshMain.mockResolvedValue(undefined)
  mocks.syncFindUnique.mockResolvedValue({ status: 'idle' })
  vi.stubGlobal('fetch', vi.fn())
}

describe('contact profile rate-limited refresh', () => {
  beforeEach(() => {
    vi.useRealTimers()
    reset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('fresh data makes a refresh decision without an external request', async () => {
    const fresh = {
      ...staleConnection,
      lastSuccessfulSyncAt: new Date(Date.now() - 60_000),
    }
    reset(fresh)

    const result = await refreshContactDriverProfiles({ contactId: 'contact-1' })

    expect(result).toEqual([{
      parkCode: 'NASH_AVTOPARK',
      parkName: 'Наш Автопарк',
      status: 'fresh',
      retryAt: null,
    }])
    expect(fetch).not.toHaveBeenCalled()
  })

  test('stale data performs one request for all profiles of the same park', async () => {
    const fetchMock = vi.mocked(fetch)
    fetchMock.mockResolvedValue(okResponse())
    mocks.driverFindMany.mockResolvedValue([
      attachedProfile,
      { externalParkId: 'park-ext-1', externalDriverProfileId: 'profile-2' },
      { externalParkId: 'park-ext-1', externalDriverProfileId: 'profile-1' },
    ])

    const result = await refreshContactDriverProfiles({ contactId: 'contact-1' })

    expect(result[0]?.status).toBe('refreshed')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(requestBody.query.driver_profile.id).toEqual(['profile-1', 'profile-2'])
    expect(mocks.parkUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: { lastSuccessfulSyncAt: expect.any(Date), lastErrorSummary: null },
    }))
    expect(mocks.refreshMain).toHaveBeenCalledWith('contact-1', 'card-open-refresh')
  })

  test('parallel opens for the same park coalesce to one external request', async () => {
    let releaseFetch: ((response: Response) => void) | null = null
    const fetchStarted = new Promise<void>(resolve => {
      vi.mocked(fetch).mockImplementation(() => new Promise(resolveResponse => {
        releaseFetch = response => resolveResponse(response)
        resolve()
      }))
    })

    const first = refreshContactDriverProfiles({ contactId: 'contact-1' })
    await fetchStarted
    const second = refreshContactDriverProfiles({ contactId: 'contact-1' })
    releaseFetch!(okResponse())

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(firstResult[0]?.status).toBe('refreshed')
    expect(secondResult[0]?.status).toBe('coalesced')
  })

  test('nightly ownership prevents a card-open external request', async () => {
    mocks.syncFindUnique.mockResolvedValue({ status: 'running' })

    const result = await refreshContactDriverProfiles({ contactId: 'contact-1' })

    expect(result[0]?.status).toBe('nightly_running')
    expect(fetch).not.toHaveBeenCalled()
  })

  test('429 preserves stored profiles and records only technical failure data', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(now)
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '1' }),
      text: async () => '{"code":"429","message":"Too many requests"}',
    } as Response)

    const task = refreshContactDriverProfiles({ contactId: 'contact-1' })
    await vi.runAllTimersAsync()
    const result = await task

    expect(fetch).toHaveBeenCalledTimes(3)
    expect(result[0]?.status).toBe('failed')
    expect(mocks.driverUpsert).not.toHaveBeenCalled()
    expect(mocks.refreshMain).not.toHaveBeenCalled()
    expect(mocks.parkUpdate).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        lastFailedSyncAt: expect.any(Date),
        lastErrorSummary: expect.stringContaining('Yandex API 429'),
      }),
    }))
  })

  test('a rate-limited park does not block a second stale park', async () => {
    vi.useFakeTimers()
    const secondConnection = {
      ...staleConnection,
      id: 'connection-2',
      parkId: 'park-2',
      apiConnectionId: 'api-2',
      externalParkId: 'park-ext-2',
      park: { parkCode: 'YOKO', parkName: 'YOKO' },
    }
    mocks.driverFindMany.mockResolvedValue([
      attachedProfile,
      { externalParkId: 'park-ext-2', externalDriverProfileId: 'profile-2' },
    ])
    mocks.parkFindMany.mockResolvedValue([staleConnection, secondConnection])
    mocks.parkFindUnique.mockResolvedValue({
      lastSuccessfulSyncAt: new Date(0),
      lastFailedSyncAt: null,
    })
    const rateLimited = {
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '1' }),
      text: async () => '{"code":"429","message":"Too many requests"}',
    } as Response
    vi.mocked(fetch)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(rateLimited)
      .mockResolvedValueOnce(okResponse())

    const task = refreshContactDriverProfiles({ contactId: 'contact-1' })
    await vi.runAllTimersAsync()
    const result = await task

    expect(result.map(item => item.status)).toEqual(['failed', 'refreshed'])
    expect(fetch).toHaveBeenCalledTimes(4)
    expect(mocks.refreshMain).toHaveBeenCalledTimes(1)
  })

  test('Retry-After becomes the park retry delay and no raw error reaches the result', async () => {
    vi.useFakeTimers()
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ 'retry-after': '2' }),
      text: async () => '{"code":"429","message":"Too many requests"}',
    } as Response)

    const task = refreshContactDriverProfiles({ contactId: 'contact-1' })
    await vi.runAllTimersAsync()
    const result = await task

    expect(result[0]?.retryAt).toBeTruthy()
    expect(JSON.stringify(result)).not.toContain('Too many requests')
    expect(JSON.stringify(result)).not.toContain('429')
  })
})
