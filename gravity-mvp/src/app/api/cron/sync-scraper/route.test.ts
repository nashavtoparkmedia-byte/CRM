import { beforeEach, describe, expect, it, vi } from 'vitest'

const runScheduledScraperDispatchCronV1 = vi.hoisted(() => vi.fn())
vi.mock('@/modules/operations-observability/public/v1', () => ({
    runScheduledScraperDispatchCronV1,
}))

import { GET } from './route'

describe('sync-scraper cron route authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
        runScheduledScraperDispatchCronV1.mockResolvedValue(new Response('{}'))
    })

    it('rejects a missing bearer before invoking the scheduled capability', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        const response = await GET(new Request('https://crm.example/api/cron/sync-scraper'))
        expect(response.status).toBe(401)
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })

    it('retains configured bearer acceptance and the inherited no-secret mode', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        await GET(new Request('https://crm.example/api/cron/sync-scraper', {
            headers: { authorization: 'Bearer expected-secret' },
        }))
        expect(runScheduledScraperDispatchCronV1).toHaveBeenCalledOnce()

        vi.unstubAllEnvs()
        await GET(new Request('https://crm.example/api/cron/sync-scraper'))
        expect(runScheduledScraperDispatchCronV1).toHaveBeenCalledTimes(2)
    })
})
