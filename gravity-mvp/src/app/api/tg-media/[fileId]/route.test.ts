import { afterEach, describe, expect, it, vi } from 'vitest'
import { GET } from './route'

const saved = {
    secret: process.env.BOT_CRM_SECRET,
    botApiUrl: process.env.TG_BOT_API_URL,
    fetch: global.fetch,
}

afterEach(() => {
    if (saved.secret === undefined) delete process.env.BOT_CRM_SECRET
    else process.env.BOT_CRM_SECRET = saved.secret
    if (saved.botApiUrl === undefined) delete process.env.TG_BOT_API_URL
    else process.env.TG_BOT_API_URL = saved.botApiUrl
    global.fetch = saved.fetch
    vi.restoreAllMocks()
})

describe('GET /api/tg-media/[fileId]', () => {
    it('fails closed when the internal bot credential is weak', async () => {
        process.env.BOT_CRM_SECRET = 'secret'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        const fetch = vi.fn()
        global.fetch = fetch as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(503)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('uses the bot-owned file endpoint and never exposes provider errors', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        const fetch = vi.fn().mockResolvedValue(new Response('not found', { status: 404 }))
        global.fetch = fetch as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })
        const body = await response.json()

        expect(response.status).toBe(404)
        expect(body).toEqual({ error: 'media unavailable' })
        expect(fetch).toHaveBeenCalledWith(
            new URL('/api/bot/file', 'http://tg-bot:3001'),
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ 'x-bot-signature': process.env.BOT_CRM_SECRET }),
                body: JSON.stringify({ fileId: 'Abcdefgh' }),
            }),
        )
    })

    it('returns a bounded inert file response on success', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        global.fetch = vi.fn().mockResolvedValue(new Response('image', {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        })) as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe('image/jpeg')
        expect(response.headers.get('cache-control')).toBe('private, no-store')
        expect(await response.text()).toBe('image')
    })

    it('rejects unsupported media types', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        global.fetch = vi.fn().mockResolvedValue(new Response('script', {
            status: 200,
            headers: { 'content-type': 'text/html' },
        })) as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(502)
        expect(await response.json()).toEqual({ error: 'media type unsupported' })
    })

    it('enforces the byte limit while streaming without Content-Length', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        global.fetch = vi.fn().mockResolvedValue(new Response(new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1))
                controller.close()
            },
        }), {
            status: 200,
            headers: { 'content-type': 'image/jpeg' },
        })) as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(413)
        expect(await response.json()).toEqual({ error: 'media too large' })
    })

    it('rejects invalid file ids before calling the bot', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        const fetch = vi.fn()
        global.fetch = fetch as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'bad/id' }) })

        expect(response.status).toBe(400)
        expect(fetch).not.toHaveBeenCalled()
    })

    it('refuses to send the shared credential outside the internal bot service', async () => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'https://attacker.example'
        const fetch = vi.fn()
        global.fetch = fetch as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(503)
        expect(fetch).not.toHaveBeenCalled()
    })

    it.each([
        'video/mp4', 'audio/ogg', 'audio/mpeg', 'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/zip',
    ])('keeps the existing attachment content type %s', async (contentType) => {
        process.env.BOT_CRM_SECRET = 'unit-test-bot-crm-secret-long-enough-for-auth'
        process.env.TG_BOT_API_URL = 'http://tg-bot:3001'
        global.fetch = vi.fn().mockResolvedValue(new Response('file', {
            status: 200,
            headers: { 'content-type': contentType },
        })) as unknown as typeof global.fetch

        const response = await GET({} as never, { params: Promise.resolve({ fileId: 'Abcdefgh' }) })

        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toBe(contentType)
    })
})
