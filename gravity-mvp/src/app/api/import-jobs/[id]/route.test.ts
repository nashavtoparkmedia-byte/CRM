import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// PATCH/DELETE /api/import-jobs/[id] is the MAX scraper's history-import job
// callback. It is machine to machine, so the scraper's shared webhook secret
// admits it; under the staff-session proxy a session-less call would otherwise
// be refused.

const WEBHOOK_SECRET = 'test-max-scraper-webhook-secret'
const mocks = vi.hoisted(() => ({
    deleteJob: vi.fn(),
    updateJob: vi.fn(),
    queryRaw: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: { $queryRaw: mocks.queryRaw },
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    deleteHistoryImportJobV1: mocks.deleteJob,
    updateHistoryImportJobV1: mocks.updateJob,
}))

import { DELETE, PATCH } from './route'

const params = { params: Promise.resolve({ id: 'job-1' }) }

function request(method: 'PATCH' | 'DELETE', secret: string | null = WEBHOOK_SECRET) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (secret !== null) headers['X-Max-Scraper-Webhook-Secret'] = secret
    return new Request('https://crm.example/api/import-jobs/job-1', {
        method,
        headers,
        ...(method === 'PATCH' ? { body: JSON.stringify({ status: 'completed', messagesImported: 3 }) } : {}),
    })
}

describe('MAX history-import job callback admission', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', WEBHOOK_SECRET)
        mocks.deleteJob.mockResolvedValue(undefined)
        mocks.updateJob.mockResolvedValue(undefined)
        mocks.queryRaw.mockResolvedValue([{ min_date: null, max_date: null }])
    })

    afterEach(() => {
        vi.unstubAllEnvs()
    })

    it.each([
        ['PATCH', 'missing secret', null],
        ['PATCH', 'wrong secret', 'wrong-secret'],
        ['DELETE', 'missing secret', null],
        ['DELETE', 'wrong secret', 'wrong-secret'],
    ] as const)('%s with a %s is refused before any job read or write', async (method, _label, secret) => {
        const handler = method === 'PATCH' ? PATCH : DELETE
        const response = await handler(request(method, secret) as any, params)

        expect(response.status).toBe(401)
        await expect(response.json()).resolves.toEqual({ error: 'MAX_SCRAPER_WEBHOOK_UNAUTHORIZED' })
        expect(mocks.queryRaw).not.toHaveBeenCalled()
        expect(mocks.updateJob).not.toHaveBeenCalled()
        expect(mocks.deleteJob).not.toHaveBeenCalled()
    })

    it.each(['PATCH', 'DELETE'] as const)('%s is refused when the CRM has no secret configured, even with a header', async (method) => {
        vi.stubEnv('MAX_SCRAPER_WEBHOOK_SECRET', '')
        const handler = method === 'PATCH' ? PATCH : DELETE
        const response = await handler(request(method, WEBHOOK_SECRET) as any, params)

        expect(response.status).toBe(401)
        expect(mocks.updateJob).not.toHaveBeenCalled()
        expect(mocks.deleteJob).not.toHaveBeenCalled()
    })

    it('PATCH with the secret updates the job as before', async () => {
        const response = await PATCH(request('PATCH') as any, params)

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ ok: true })
        expect(mocks.updateJob).toHaveBeenCalledTimes(1)
        expect(mocks.updateJob.mock.calls[0][0]).toMatchObject({ jobId: 'job-1', status: 'completed', messagesImported: 3 })
    })

    it('DELETE with the secret deletes the job as before', async () => {
        const response = await DELETE(request('DELETE') as any, params)

        expect(response.status).toBe(200)
        await expect(response.json()).resolves.toEqual({ ok: true })
        expect(mocks.deleteJob).toHaveBeenCalledTimes(1)
        expect(mocks.deleteJob.mock.calls[0][0]).toMatchObject({ jobId: 'job-1' })
    })
})
