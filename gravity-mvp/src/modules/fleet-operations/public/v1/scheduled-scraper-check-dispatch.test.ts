import { beforeEach, describe, expect, it, vi } from 'vitest'

const { findConnection } = vi.hoisted(() => ({ findConnection: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
    prisma: { apiConnection: { findFirst: findConnection } },
}))

import { dispatchScheduledScraperChecksV1 } from './scheduled-scraper-check-dispatch'

describe('scheduled scraper check dispatch', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.unstubAllGlobals()
        findConnection.mockResolvedValue({
            clid: 'client-id',
            apiKey: 'secret-key',
            parkId: 'park-id',
        })
    })

    it('keeps missing credentials inside Fleet and reports only the fixed outcome', async () => {
        findConnection.mockResolvedValueOnce(null)
        const fetchMock = vi.fn()
        vi.stubGlobal('fetch', fetchMock)

        await expect(dispatchScheduledScraperChecksV1()).resolves.toEqual({
            status: 'connection_missing',
        })
        expect(fetchMock).not.toHaveBeenCalled()
    })

    it('normalizes licenses and preserves sequential aggregate dispatch counts', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    total: 2,
                    driver_profiles: [
                        { driver_profile: { license_info: { number: ' a 12 ' } } },
                        { driver_profile: { license_info: { number: 'b34' } } },
                    ],
                }),
            })
            .mockResolvedValueOnce({ ok: true })
            .mockResolvedValueOnce({ ok: false })
        vi.stubGlobal('fetch', fetchMock)

        await expect(dispatchScheduledScraperChecksV1()).resolves.toEqual({
            status: 'success',
            dispatched: 2,
            successCount: 1,
            errorCount: 1,
        })
        expect(findConnection).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } })
        expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(JSON.stringify({
            license: 'A12',
            priority: 'NORMAL',
        }))
        expect(fetchMock.mock.calls[2]?.[1]?.body).toBe(JSON.stringify({
            license: 'B34',
            priority: 'NORMAL',
        }))
    })

    it('retains a partial successful license page when Yandex later returns non-success', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce({
                ok: true,
                json: async () => ({
                    total: 501,
                    driver_profiles: [
                        { driver_profile: { license_info: { number: 'first' } } },
                    ],
                }),
            })
            .mockResolvedValueOnce({ ok: false, text: async () => 'provider down' })
            .mockResolvedValueOnce({ ok: true })
        vi.stubGlobal('fetch', fetchMock)

        await expect(dispatchScheduledScraperChecksV1()).resolves.toEqual({
            status: 'success',
            dispatched: 1,
            successCount: 1,
            errorCount: 0,
        })
    })

    it('returns a secret-free error outcome while connection lookup failures stay visible', async () => {
        const failure = new Error('provider payload failed')
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(failure))
        await expect(dispatchScheduledScraperChecksV1()).resolves.toEqual({
            status: 'error',
            errorMessage: 'provider payload failed',
        })

        const lookupFailure = new Error('credential store unavailable')
        findConnection.mockRejectedValueOnce(lookupFailure)
        await expect(dispatchScheduledScraperChecksV1()).rejects.toBe(lookupFailure)
    })
})
