import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    dispatchScraper: vi.fn(),
    runYandexSync: vi.fn(),
    logCronHealth: vi.fn(async () => undefined),
}))
vi.mock('@/modules/fleet-operations/public/v1', () => ({
    dispatchScheduledScraperChecksV1: operations.dispatchScraper,
    runScheduledYandexSyncV1: operations.runYandexSync,
}))
vi.mock('@/lib/cron-health', () => ({ logCronHealth: operations.logCronHealth }))

import {
    runScheduledScraperDispatchCronV1,
    runScheduledYandexSyncCronV1,
} from './scheduled-fleet-cron-routes'

describe('Operations scheduled Fleet cron routes', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValue(125)
    })

    it('preserves scraper success response and fire-and-forget health metadata', async () => {
        operations.dispatchScraper.mockResolvedValue({
            status: 'success',
            dispatched: 4,
            successCount: 3,
            errorCount: 1,
        })
        const response = await runScheduledScraperDispatchCronV1()
        await expect(response.json()).resolves.toEqual({
            success: true,
            dispatched: 4,
            successCount: 3,
            errorCount: 1,
        })
        expect(operations.logCronHealth).toHaveBeenCalledWith({
            cronName: 'sync-scraper',
            status: 'ok',
            durationMs: 25,
            metadata: { dispatched: 4, successCount: 3, errorCount: 1 },
        })
    })

    it('preserves scraper missing-connection and error status policies', async () => {
        operations.dispatchScraper.mockResolvedValueOnce({ status: 'connection_missing' })
        const missing = await runScheduledScraperDispatchCronV1()
        expect(missing.status).toBe(503)
        expect(operations.logCronHealth).not.toHaveBeenCalled()

        vi.spyOn(Date, 'now').mockRestore()
        vi.spyOn(Date, 'now').mockReturnValueOnce(200).mockReturnValue(230)
        operations.dispatchScraper.mockResolvedValueOnce({
            status: 'error',
            errorMessage: 'provider down',
        })
        const failed = await runScheduledScraperDispatchCronV1()
        expect(failed.status).toBe(500)
        await expect(failed.json()).resolves.toEqual({ error: 'provider down' })
        expect(operations.logCronHealth).toHaveBeenCalledWith({
            cronName: 'sync-scraper',
            status: 'error',
            durationMs: 30,
            errorMessage: 'provider down',
        })
    })

    it('preserves sync success and non-ok status mapping', async () => {
        operations.runYandexSync.mockResolvedValueOnce({
            ok: true,
            driversUpdated: 2,
            ordersProcessed: 7,
            recalculatedCount: 1,
        })
        const success = await runScheduledYandexSyncCronV1()
        expect(success.status).toBe(200)
        expect(operations.logCronHealth).toHaveBeenCalledWith({
            cronName: 'sync-trips',
            status: 'ok',
            durationMs: 25,
            metadata: { driversUpdated: 2, ordersProcessed: 7, recalculatedCount: 1 },
        })

        vi.spyOn(Date, 'now').mockRestore()
        vi.spyOn(Date, 'now').mockReturnValueOnce(300).mockReturnValue(320)
        operations.runYandexSync.mockResolvedValueOnce({
            ok: false,
            reason: 'cooldown',
            cooldownRemainingMs: 10,
        })
        const skipped = await runScheduledYandexSyncCronV1()
        expect(skipped.status).toBe(409)
        await expect(skipped.json()).resolves.toEqual({ ok: false, reason: 'cooldown' })
    })

    it('preserves unexpected sync error response and health logging', async () => {
        operations.runYandexSync.mockRejectedValueOnce(new Error('sync exploded'))
        const response = await runScheduledYandexSyncCronV1()
        expect(response.status).toBe(500)
        await expect(response.json()).resolves.toEqual({ error: 'sync exploded' })
        expect(operations.logCronHealth).toHaveBeenCalledWith({
            cronName: 'sync-trips',
            status: 'error',
            durationMs: 25,
            errorMessage: 'sync exploded',
        })
    })
})
