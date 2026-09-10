import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'
import { YandexFleetService } from '@/lib/YandexFleetService'

vi.mock('@/lib/prisma', () => ({
    prisma: {
        apiConnection: { findMany: vi.fn() },
        driver: { findMany: vi.fn() },
        driverDaySummary: { upsert: vi.fn() },
    },
}))

type ParkRow = { clid: string; apiKey: string; parkId: string; name: string | null }
type DriverRow = {
    id: string
    yandexDriverId: string
    externalParkId: string | null
    externalDriverProfileId: string | null
}
type OrderRow = { status: string; driver_profile: { id: string }; booked_at: string }
type SummaryUpsert = {
    where: { driverId_date: { driverId: string; date: Date } }
    update: { tripCount: number }
    create: { driverId: string; date: Date; tripCount: number }
}

const PARKS: ParkRow[] = [
    { clid: 'clid_1', apiKey: 'key_1', parkId: 'park_a', name: 'Yoko' },
    { clid: 'clid_2', apiKey: 'key_2', parkId: 'park_b', name: 'Yoko-2' },
    { clid: 'clid_3', apiKey: 'key_3', parkId: 'park_c', name: 'Yoko-3' },
]

const DRIVERS: DriverRow[] = [
    // Same person, one profile per park — distinct Driver rows.
    { id: 'drv_a', yandexDriverId: 'profile_a', externalParkId: 'park_a', externalDriverProfileId: 'profile_a' },
    { id: 'drv_b', yandexDriverId: 'imported_legacy_b', externalParkId: 'park_b', externalDriverProfileId: 'profile_b' },
    // Legacy row with no park identity: only the yandexDriverId fallback can reach it.
    { id: 'drv_c', yandexDriverId: 'profile_c', externalParkId: null, externalDriverProfileId: null },
]

function completedOrder(profileId: string, bookedAt: string): OrderRow {
    return { status: 'complete', driver_profile: { id: profileId }, booked_at: bookedAt }
}

function okResponse(body: unknown): Response {
    return {
        ok: true,
        status: 200,
        json: async () => body,
        headers: { get: () => null },
    } as unknown as Response
}

function errorResponse(status: number, text: string): Response {
    return {
        ok: false,
        status,
        text: async () => text,
        headers: { get: () => null },
    } as unknown as Response
}

/** Route each park's fetch by the parkId carried in the request body. */
function mockFetchByPark(ordersByPark: Record<string, OrderRow[]>, failing: Record<string, number> = {}) {
    return vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as { query: { park: { id: string } } }
        const parkId = body.query.park.id
        if (failing[parkId]) return errorResponse(failing[parkId], `park ${parkId} rejected`)
        return okResponse({ orders: ordersByPark[parkId] ?? [] })
    })
}

const upsertCalls = (): SummaryUpsert[] =>
    vi.mocked(prisma.driverDaySummary.upsert).mock.calls.map(call => call[0] as unknown as SummaryUpsert)

const touchedDriverIds = (): string[] => upsertCalls().map(call => call.where.driverId_date.driverId).sort()

const resolveWith = <T,>(rows: T[]) => rows as unknown as never

describe('YandexFleetService.syncTrips — multi-park', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.mocked(prisma.apiConnection.findMany).mockResolvedValue(resolveWith(PARKS))
        vi.mocked(prisma.driver.findMany).mockResolvedValue(resolveWith(DRIVERS))
        vi.mocked(prisma.driverDaySummary.upsert).mockResolvedValue(resolveWith([{}])[0])
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('calls every configured park connection, not only the latest', async () => {
        const fetchMock = mockFetchByPark({})
        vi.stubGlobal('fetch', fetchMock)

        const result = await YandexFleetService.syncTrips(7)

        expect(fetchMock).toHaveBeenCalledTimes(3)
        const requestedParks = fetchMock.mock.calls
            .map(([, init]) => (JSON.parse(String(init.body)) as { query: { park: { id: string } } }).query.park.id)
        expect(requestedParks.sort()).toEqual(['park_a', 'park_b', 'park_c'])
        expect(result.connectionsTotal).toBe(3)
        expect(result.connectionsSucceeded).toBe(3)
        expect(result.failures).toEqual([])
    })

    it('routes each park\'s orders to the Driver row of that same park', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_a: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')],
            park_b: [completedOrder('profile_b', '2026-08-04T09:00:00+00:00')],
        }))

        await YandexFleetService.syncTrips(7)

        expect(touchedDriverIds()).toEqual(['drv_a', 'drv_b'])
    })

    it('matches a park-scoped profile even when yandexDriverId differs', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_b: [completedOrder('profile_b', '2026-08-04T09:00:00+00:00')],
        }))

        await YandexFleetService.syncTrips(7)

        expect(upsertCalls()).toHaveLength(1)
        expect(touchedDriverIds()).toEqual(['drv_b'])
    })

    it('falls back to yandexDriverId for rows without park identity', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_c: [completedOrder('profile_c', '2026-08-04T09:00:00+00:00')],
        }))

        await YandexFleetService.syncTrips(7)

        expect(upsertCalls()).toHaveLength(1)
        expect(touchedDriverIds()).toEqual(['drv_c'])
    })

    it('counts only completed orders', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_a: [
                completedOrder('profile_a', '2026-08-04T09:00:00+00:00'),
                { status: 'cancelled', driver_profile: { id: 'profile_a' }, booked_at: '2026-08-04T10:00:00+00:00' },
                { status: 'transporting', driver_profile: { id: 'profile_a' }, booked_at: '2026-08-04T11:00:00+00:00' },
            ],
        }))

        await YandexFleetService.syncTrips(7)

        const calls = upsertCalls()
        expect(calls).toHaveLength(1)
        expect(calls[0].update.tripCount).toBe(1)
    })

    it('is idempotent: a repeated sync sets the same tripCount, never adds to it', async () => {
        const orders = {
            park_a: [
                completedOrder('profile_a', '2026-08-04T09:00:00+00:00'),
                completedOrder('profile_a', '2026-08-04T18:00:00+00:00'),
            ],
        }

        vi.stubGlobal('fetch', mockFetchByPark(orders))
        await YandexFleetService.syncTrips(7)
        const first = upsertCalls()

        vi.mocked(prisma.driverDaySummary.upsert).mockClear()
        vi.stubGlobal('fetch', mockFetchByPark(orders))
        await YandexFleetService.syncTrips(7)
        const second = upsertCalls()

        expect(first).toHaveLength(1)
        expect(second).toHaveLength(1)
        expect(first[0].update.tripCount).toBe(2)
        expect(second[0].update.tripCount).toBe(2)
        // `update` assigns the count; it must never become a relative increment.
        expect(JSON.stringify(second[0].update)).not.toContain('increment')
        expect(second[0].create.tripCount).toBe(2)
    })

    it('buckets a day by park-local time, not UTC', async () => {
        // 2026-08-04T20:30Z is already 2026-08-05 in Asia/Yekaterinburg (UTC+5).
        vi.stubGlobal('fetch', mockFetchByPark({
            park_a: [completedOrder('profile_a', '2026-08-04T20:30:00+00:00')],
        }))

        await YandexFleetService.syncTrips(7)

        expect(upsertCalls()[0].where.driverId_date.date.toISOString()).toBe('2026-08-05T00:00:00.000Z')
    })

    it('keeps syncing the remaining parks when one connection fails', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_a: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')],
            park_c: [completedOrder('profile_c', '2026-08-04T09:00:00+00:00')],
        }, { park_b: 403 }))

        const result = await YandexFleetService.syncTrips(7)

        expect(result.success).toBe(true)
        expect(result.connectionsSucceeded).toBe(2)
        expect(result.failures).toHaveLength(1)
        expect(result.failures[0].parkId).toBe('park_b')
        expect(result.failures[0].name).toBe('Yoko-2')
        expect(touchedDriverIds()).toEqual(['drv_a', 'drv_c'])
    })

    it('reports a park whose window was cut short instead of passing it off as complete', async () => {
        // Always hand back a fresh cursor so the walk can only end at the bound.
        let page = 0
        const fetchMock = vi.fn(async () => {
            page += 1
            return okResponse({
                orders: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')],
                cursor: `cursor_${page}`,
            })
        })
        vi.mocked(prisma.apiConnection.findMany).mockResolvedValue(resolveWith([PARKS[0]]))
        vi.stubGlobal('fetch', fetchMock)
        // Skip the polite inter-page delay so the bound is reached instantly.
        vi.stubGlobal('setTimeout', (fn: () => void) => {
            fn()
            return 0 as unknown as ReturnType<typeof setTimeout>
        })

        const result = await YandexFleetService.syncTrips(45)

        expect(result.success).toBe(true)
        expect(result.truncated).toHaveLength(1)
        expect(result.truncated[0].parkId).toBe('park_a')
        expect(result.truncated[0].message).toMatch(/truncated/)
        // The bound still holds, so the walk terminates.
        expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(400)
    }, 120_000)

    it('reports no truncation for a window that completes normally', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({
            park_a: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')],
        }))

        const result = await YandexFleetService.syncTrips(7)

        expect(result.truncated).toEqual([])
    })

    it('throws when every connection fails, so a total outage is not reported as success', async () => {
        vi.stubGlobal('fetch', mockFetchByPark({}, { park_a: 500, park_b: 500, park_c: 500 }))

        await expect(YandexFleetService.syncTrips(7)).rejects.toThrow(/all 3 park connection/)
    })

    it('still throws when no connection is configured', async () => {
        vi.mocked(prisma.apiConnection.findMany).mockResolvedValue(resolveWith([]))
        vi.stubGlobal('fetch', mockFetchByPark({}))

        await expect(YandexFleetService.syncTrips(7)).rejects.toThrow('No API connection configured')
    })

    it('preserves single-connection behaviour when only one park is configured', async () => {
        vi.mocked(prisma.apiConnection.findMany).mockResolvedValue(resolveWith([PARKS[0]]))
        const fetchMock = mockFetchByPark({
            park_a: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')],
        })
        vi.stubGlobal('fetch', fetchMock)

        const result = await YandexFleetService.syncTrips(7)

        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(result.ordersProcessed).toBe(1)
        expect(result.driversUpdated).toBe(1)
        expect(result.connectionsTotal).toBe(1)
        expect(result.failures).toEqual([])
    })

    it('follows the cursor and keeps paginating within one park', async () => {
        let page = 0
        const fetchMock = vi.fn(async () => {
            page += 1
            return page === 1
                ? okResponse({ orders: [completedOrder('profile_a', '2026-08-04T09:00:00+00:00')], cursor: 'c1' })
                : okResponse({ orders: [completedOrder('profile_a', '2026-08-05T09:00:00+00:00')] })
        })
        vi.mocked(prisma.apiConnection.findMany).mockResolvedValue(resolveWith([PARKS[0]]))
        vi.stubGlobal('fetch', fetchMock)

        const result = await YandexFleetService.syncTrips(7)

        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(result.ordersProcessed).toBe(2)
        expect(upsertCalls()).toHaveLength(2)
    })
})
