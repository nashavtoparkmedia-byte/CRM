import { beforeEach, describe, expect, it, vi } from 'vitest'

const runScheduledScraperDispatchCronV1 = vi.hoisted(() => vi.fn())
vi.mock('@/modules/operations-observability/public/v1', () => ({
    runScheduledScraperDispatchCronV1,
}))

import { GET } from './route'

const request = (authorization?: string) => new Request(
    'https://crm.example/api/cron/sync-scraper',
    authorization === undefined ? undefined : { headers: { authorization } },
)

describe('sync-scraper cron route authorization', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllEnvs()
        runScheduledScraperDispatchCronV1.mockResolvedValue(new Response('{}'))
    })

    it('rejects a missing bearer before invoking the scheduled capability', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        const response = await GET(request())
        expect(response.status).toBe(401)
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })

    it('rejects a wrong bearer before invoking the scheduled capability', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        const response = await GET(request('Bearer wrong-secret'))
        expect(response.status).toBe(401)
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })

    it('fails closed when CRON_SECRET is unset: every caller shape is denied', async () => {
        vi.unstubAllEnvs()
        for (const authorization of [undefined, 'Bearer ', 'Bearer undefined', 'Bearer expected-secret']) {
            const response = await GET(request(authorization))
            expect(response.status, `authorization=${String(authorization)}`).toBe(401)
        }
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })

    it('fails closed when CRON_SECRET is the empty string', async () => {
        vi.stubEnv('CRON_SECRET', '')
        for (const authorization of [undefined, 'Bearer ', 'Bearer ']) {
            const response = await GET(request(authorization))
            expect(response.status, `authorization=${String(authorization)}`).toBe(401)
        }
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })

    it('accepts the configured bearer and only then invokes the scheduled capability', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
        await GET(request('Bearer expected-secret'))
        expect(runScheduledScraperDispatchCronV1).toHaveBeenCalledOnce()
    })

    it('denies every rejected shape without ever reaching the capability', async () => {
        vi.stubEnv('CRON_SECRET', 'expected-secret')
        for (const authorization of [undefined, '', 'expected-secret', 'bearer expected-secret', 'Basic ZXhwZWN0ZWQ=']) {
            const response = await GET(request(authorization))
            expect(response.status, `authorization=${String(authorization)}`).toBe(401)
        }
        expect(runScheduledScraperDispatchCronV1).not.toHaveBeenCalled()
    })
})
