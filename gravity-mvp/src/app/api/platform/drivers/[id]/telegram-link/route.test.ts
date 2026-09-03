import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
    removeDriverTelegramLink,
    saveDriverTelegramLink,
} from '@/modules/platform-shell/internal/driver-telegram-link-orchestrator'
import { getIntegrationAdminPrincipal } from '@/modules/identity-access/public/v1'

import { DELETE, POST, isSameOriginMutationRequest } from './route'

vi.mock('@/modules/platform-shell/internal/driver-telegram-link-orchestrator', () => ({
    saveDriverTelegramLink: vi.fn(),
    removeDriverTelegramLink: vi.fn(),
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
    ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
    getIntegrationAdminPrincipal: vi.fn(),
}))

const save = vi.mocked(saveDriverTelegramLink)
const remove = vi.mocked(removeDriverTelegramLink)
const adminPrincipal = vi.mocked(getIntegrationAdminPrincipal)
const context = { params: Promise.resolve({ id: 'driver/1' }) }

function request(method: 'POST' | 'DELETE', options: {
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
    return new NextRequest('https://crm.example/api/platform/drivers/driver%2F1/telegram-link', {
        method,
        headers,
        ...(options.body !== undefined ? { body: options.body } : {}),
    })
}

beforeEach(() => {
    vi.clearAllMocks()
    adminPrincipal.mockResolvedValue({
        id: 'identity-access:integration-admin-session',
        kind: 'integration_admin_session',
    })
})

describe('driver Telegram link route security and mapping', () => {
    it('accepts only an exact Origin/Host/protocol match', () => {
        expect(isSameOriginMutationRequest(request('DELETE', {
            origin: 'https://crm.example',
            host: 'crm.example',
            forwardedHost: 'CRM.EXAMPLE, proxy.internal',
            forwardedProtocol: 'https, http',
        }))).toBe(true)
        for (const candidate of [
            request('DELETE', { host: 'crm.example' }),
            request('DELETE', { origin: 'not a URL', host: 'crm.example' }),
            request('DELETE', { origin: 'https://crm.example/path', host: 'crm.example' }),
            request('DELETE', { origin: 'https://attacker@crm.example', host: 'crm.example' }),
            request('DELETE', { origin: 'https://evil.example', host: 'crm.example' }),
            request('DELETE', {
                origin: 'https://crm.example',
                host: 'crm.example',
                forwardedHost: 'evil.example',
            }),
            request('DELETE', {
                origin: 'http://crm.example',
                host: 'crm.example',
                forwardedProtocol: 'https',
            }),
            request('DELETE', {
                origin: 'https://crm.example',
                host: 'crm.example',
                forwardedProtocol: 'javascript',
            }),
        ]) expect(isSameOriginMutationRequest(candidate)).toBe(false)
    })

    it('rejects cross-origin mutations before orchestration', async () => {
        const response = await DELETE(request('DELETE', {
            origin: 'https://evil.example',
            host: 'crm.example',
        }), context)
        expect(response.status).toBe(403)
        await expect(response.json()).resolves.toEqual({ success: false, error: 'Forbidden' })
        expect(remove).not.toHaveBeenCalled()
        expect(adminPrincipal).not.toHaveBeenCalled()
    })

    it.each(['POST', 'DELETE'] as const)(
        'rejects an unauthenticated %s with zero orchestration',
        async method => {
            adminPrincipal.mockResolvedValue(null)
            const req = request(method, {
                origin: 'https://crm.example',
                host: 'crm.example',
                ...(method === 'POST' ? {
                    contentType: 'application/json',
                    body: JSON.stringify({ telegramId: '42' }),
                } : {}),
            })

            const response = method === 'POST'
                ? await POST(req, context)
                : await DELETE(req, context)
            expect(response.status).toBe(403)
            expect(save).not.toHaveBeenCalled()
            expect(remove).not.toHaveBeenCalled()
        },
    )

    it('requires JSON for POST before orchestration', async () => {
        const response = await POST(request('POST', {
            origin: 'https://crm.example',
            host: 'crm.example',
            contentType: 'text/plain',
            body: '42',
        }), context)
        expect(response.status).toBe(415)
        expect(save).not.toHaveBeenCalled()
    })

    it('maps the same-origin JSON save request and returns its handled result', async () => {
        save.mockResolvedValue({ success: true, mutated: true })
        const response = await POST(request('POST', {
            origin: 'https://crm.example',
            host: 'crm.example',
            contentType: 'application/json; charset=utf-8',
            body: JSON.stringify({ telegramId: '42' }),
        }), context)
        expect(response.status).toBe(200)
        expect(save).toHaveBeenCalledWith({ driverId: 'driver/1', telegramId: '42' })
        await expect(response.json()).resolves.toEqual({ success: true, mutated: true })
    })

    it('maps same-origin DELETE without a request body', async () => {
        remove.mockResolvedValue({ success: true, mutated: false })
        const response = await DELETE(request('DELETE', {
            origin: 'https://crm.example',
            host: 'crm.example',
        }), context)
        expect(response.status).toBe(200)
        expect(remove).toHaveBeenCalledWith('driver/1')
        await expect(response.json()).resolves.toEqual({ success: true, mutated: false })
    })
})
