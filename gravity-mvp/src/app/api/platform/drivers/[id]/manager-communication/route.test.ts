import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { recordManagerDriverCommunication } from '@/modules/platform-shell/internal/manager-driver-communication-orchestrator'

import { POST, isSameOriginMutationRequest } from './route'

vi.mock('@/modules/platform-shell/internal/manager-driver-communication-orchestrator', () => ({
    recordManagerDriverCommunication: vi.fn(),
}))

const record = vi.mocked(recordManagerDriverCommunication)
const context = { params: Promise.resolve({ id: 'driver/1' }) }

function request(options: {
    origin?: string
    host?: string
    forwardedHost?: string
    forwardedProtocol?: string
    contentType?: string
    body?: string
} = {}) {
    const headers = new Headers()
    if (options.origin !== undefined) headers.set('origin', options.origin)
    if (options.host !== undefined) headers.set('host', options.host)
    if (options.forwardedHost !== undefined) headers.set('x-forwarded-host', options.forwardedHost)
    if (options.forwardedProtocol !== undefined) headers.set('x-forwarded-proto', options.forwardedProtocol)
    if (options.contentType !== undefined) headers.set('content-type', options.contentType)
    return new NextRequest('https://crm.example/api/platform/drivers/driver%2F1/manager-communication', {
        method: 'POST',
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
    })
}

function sameOrigin(body: unknown, overrides: Parameters<typeof request>[0] = {}) {
    return request({
        origin: 'https://crm.example',
        host: 'crm.example',
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
        ...overrides,
    })
}

beforeEach(() => {
    vi.clearAllMocks()
})

describe('manager-driver communication route security and mapping', () => {
    it('accepts only an exact Origin/Host/protocol match', () => {
        expect(isSameOriginMutationRequest(request({
            origin: 'https://crm.example',
            host: 'crm.example',
            forwardedHost: 'CRM.EXAMPLE, proxy.internal',
            forwardedProtocol: 'https, http',
        }))).toBe(true)
        for (const candidate of [
            request({ host: 'crm.example' }),
            request({ origin: 'not a URL', host: 'crm.example' }),
            request({ origin: 'https://evil.example', host: 'crm.example' }),
            request({
                origin: 'https://crm.example',
                host: 'crm.example',
                forwardedHost: 'evil.example',
            }),
            request({
                origin: 'http://crm.example',
                host: 'crm.example',
                forwardedProtocol: 'https',
            }),
            request({
                origin: 'https://crm.example',
                host: 'crm.example',
                forwardedProtocol: 'javascript',
            }),
        ]) expect(isSameOriginMutationRequest(candidate)).toBe(false)
    })

    it('rejects cross-origin requests before orchestration', async () => {
        const response = await POST(sameOrigin({ activity: 'call' }, {
            origin: 'https://evil.example',
        }), context)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({ success: false, error: 'Forbidden' })
        expect(record).not.toHaveBeenCalled()
    })

    it('requires JSON before orchestration', async () => {
        const response = await POST(sameOrigin({ activity: 'call' }, {
            contentType: 'text/plain',
        }), context)
        expect(response.status).toBe(415)
        await expect(response.json()).resolves.toEqual({
            success: false,
            error: 'Unsupported Media Type',
        })
        expect(record).not.toHaveBeenCalled()
    })

    it.each([
        ['malformed JSON', '{'],
        ['a missing activity', JSON.stringify({})],
        ['an unknown activity', JSON.stringify({ activity: 'email' })],
        ['an extra field', JSON.stringify({ activity: 'call', driverId: 'other' })],
        ['an array', JSON.stringify(['call'])],
    ])('rejects %s as bad input', async (_name, body) => {
        const response = await POST(sameOrigin(null, { body }), context)
        expect(response.status).toBe(400)
        await expect(response.json()).resolves.toEqual({ success: false, error: 'Bad Request' })
        expect(record).not.toHaveBeenCalled()
    })

    it.each(['call', 'message'] as const)('maps the exact %s activity and returns success', async (activity) => {
        record.mockResolvedValue(undefined)
        const response = await POST(sameOrigin({ activity }), context)
        expect(response.status).toBe(200)
        expect(record).toHaveBeenCalledTimes(1)
        expect(record).toHaveBeenCalledWith('driver/1', activity)
        await expect(response.json()).resolves.toEqual({ success: true })
    })

    it('leaves owner failures visible', async () => {
        record.mockRejectedValue(new Error('owner unavailable'))
        await expect(POST(sameOrigin({ activity: 'call' }), context))
            .rejects.toThrow('owner unavailable')
    })
})
