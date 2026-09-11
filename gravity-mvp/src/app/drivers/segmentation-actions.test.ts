import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * Both Yandex Fleet sync triggers are server actions, i.e. HTTP-invocable
 * endpoints. They load every park's ApiConnection credentials and call the
 * Fleet API, so they must authorize through the existing integration-admin
 * boundary before reaching the fleet capability.
 */

class IntegrationAdminAuthorizationError extends Error {
    constructor() {
        super('integration_admin_auth_required')
        this.name = 'IntegrationAdminAuthorizationError'
    }
}

const requireIntegrationAdminAccess = vi.hoisted(() => vi.fn())
const runYandexSync = vi.hoisted(() => vi.fn())
const syncTrips = vi.hoisted(() => vi.fn())
const recalculateAllSegments = vi.hoisted(() => vi.fn())
const getThresholds = vi.hoisted(() => vi.fn())
const revalidatePath = vi.hoisted(() => vi.fn())
const prismaUpdate = vi.hoisted(() => vi.fn())

vi.mock('@/modules/identity-access/public/v1', () => ({ requireIntegrationAdminAccess }))
vi.mock('@/lib/yandexSync', () => ({ runYandexSync, getYandexSyncStatus: vi.fn() }))
vi.mock('@/lib/YandexFleetService', () => ({ YandexFleetService: { syncTrips } }))
vi.mock('@/lib/scoring', () => ({
    getThresholds,
    recalculateAllSegments,
    getSharedSegmentationStats: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath }))
vi.mock('@/lib/prisma', () => ({
    prisma: {
        segmentationSetting: { update: prismaUpdate, upsert: prismaUpdate },
        driver: { update: prismaUpdate, updateMany: prismaUpdate, findMany: vi.fn() },
        $transaction: vi.fn(),
    },
}))

import { triggerRecalculation, triggerYandexSync } from './segmentation-actions'

const fetchSpy = vi.fn()

/** Every side effect the rejected calls must not reach. */
const protectedEffects = () => [
    ['runYandexSync', runYandexSync],
    ['YandexFleetService.syncTrips', syncTrips],
    ['recalculateAllSegments', recalculateAllSegments],
    ['getThresholds', getThresholds],
    ['prisma write', prismaUpdate],
    ['fetch', fetchSpy],
    ['revalidatePath', revalidatePath],
] as const

const expectNoProtectedEffect = () => {
    for (const [label, spy] of protectedEffects()) {
        expect(spy, `${label} must not run on a rejected call`).not.toHaveBeenCalled()
    }
}

describe('Yandex Fleet sync triggers authorize before the fleet capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubGlobal('fetch', fetchSpy)
        getThresholds.mockResolvedValue({ analysis_period: 45 })
        recalculateAllSegments.mockResolvedValue({ count: 7 })
        runYandexSync.mockResolvedValue({ ok: true, driversUpdated: 1, ordersProcessed: 2 })
        syncTrips.mockResolvedValue({ success: true })
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('an unauthenticated caller cannot trigger the manual sync', async () => {
        requireIntegrationAdminAccess.mockRejectedValue(new IntegrationAdminAuthorizationError())
        await expect(triggerYandexSync()).rejects.toThrow('integration_admin_auth_required')
        expectNoProtectedEffect()
    })

    it('an unauthenticated caller cannot trigger the recalculation sync', async () => {
        requireIntegrationAdminAccess.mockRejectedValue(new IntegrationAdminAuthorizationError())
        await expect(triggerRecalculation()).rejects.toThrow('integration_admin_auth_required')
        expectNoProtectedEffect()
    })

    it('an unauthorized caller (a principal the guard refuses) cannot trigger either action', async () => {
        requireIntegrationAdminAccess.mockRejectedValue(new IntegrationAdminAuthorizationError())
        await expect(triggerYandexSync()).rejects.toBeInstanceOf(Error)
        await expect(triggerRecalculation()).rejects.toBeInstanceOf(Error)
        expect(requireIntegrationAdminAccess).toHaveBeenCalledTimes(2)
        expectNoProtectedEffect()
    })

    it('authorization is attempted before the fleet capability, not after', async () => {
        const order: string[] = []
        requireIntegrationAdminAccess.mockImplementation(async () => { order.push('authorize') })
        runYandexSync.mockImplementation(async () => { order.push('runYandexSync'); return { ok: true } })
        syncTrips.mockImplementation(async () => { order.push('syncTrips'); return { success: true } })

        await triggerYandexSync()
        expect(order).toEqual(['authorize', 'runYandexSync'])

        order.length = 0
        await triggerRecalculation()
        expect(order[0]).toBe('authorize')
        expect(order).toContain('syncTrips')
        expect(order.indexOf('authorize')).toBeLessThan(order.indexOf('syncTrips'))
    })

    it('an authorized admin still reaches the sync and gets its result', async () => {
        requireIntegrationAdminAccess.mockResolvedValue({ subject: 'integration-admin' })

        const manual = await triggerYandexSync()
        expect(runYandexSync).toHaveBeenCalledOnce()
        expect(manual).toEqual({ ok: true, driversUpdated: 1, ordersProcessed: 2 })

        const recalculated = await triggerRecalculation()
        expect(syncTrips).toHaveBeenCalledWith(45)
        expect(recalculated.count).toBe(7)
    })

    it('a rejected call performs no network request and no database mutation', async () => {
        requireIntegrationAdminAccess.mockRejectedValue(new IntegrationAdminAuthorizationError())
        await expect(triggerYandexSync()).rejects.toThrow()
        await expect(triggerRecalculation()).rejects.toThrow()
        expect(fetchSpy).not.toHaveBeenCalled()
        expect(prismaUpdate).not.toHaveBeenCalled()
        expect(revalidatePath).not.toHaveBeenCalled()
    })
})
