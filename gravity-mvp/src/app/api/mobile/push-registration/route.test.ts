// @vitest-environment node
import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { register } = vi.hoisted(() => ({ register: vi.fn() }))
vi.mock('@/modules/identity-access/public/v1/mobile-push-session', () => ({
    registerMobilePushDeviceFromSessionV1: register,
}))

import { POST } from './route'

const TOKEN = 'route-token_0123456789:ABCDEFGHIJKLMNOPQRSTUV'

function request(body: string, contentType = 'application/json') {
    return new NextRequest('http://localhost/api/mobile/push-registration', { method: 'POST', headers: { 'content-type': contentType }, body })
}

describe('POST /api/mobile/push-registration', () => {
    beforeEach(() => register.mockReset())

    it('passes only the token on, and answers without echoing it', async () => {
        register.mockResolvedValue({ ok: true, registrationId: 'reg_1', reclaimedStaleBinding: false })
        const response = await POST(request(JSON.stringify({ token: TOKEN })))
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true })
        expect(register).toHaveBeenCalledWith(TOKEN)
        expect(response.headers.get('cache-control')).toBe('no-store')
    })

    it('maps each refusal to its status without leaking detail', async () => {
        for (const [code, status] of [['MOBILE_SESSION_REQUIRED', 401], ['PUSH_DEVICE_ID_NOT_STABLE', 422], ['PUSH_TOKEN_BOUND_TO_OTHER_DEVICE', 409]] as const) {
            register.mockResolvedValueOnce({ ok: false, code })
            const response = await POST(request(JSON.stringify({ token: TOKEN })))
            expect(response.status).toBe(status)
            expect(await response.json()).toEqual({ error: code })
        }
    })

    it('refuses before any session work: wrong content type, oversized, malformed, or claiming authority', async () => {
        expect((await POST(request(JSON.stringify({ token: TOKEN }), 'text/plain'))).status).toBe(415)
        expect((await POST(request(JSON.stringify({ token: TOKEN, pad: 'x'.repeat(4096) })))).status).toBe(413)
        for (const body of ['{', '[]', JSON.stringify({}), JSON.stringify({ token: TOKEN, deviceId: 'other' }), JSON.stringify({ token: TOKEN, operatorId: 'u2' })]) {
            expect((await POST(request(body))).status).toBe(400)
        }
        expect(register).not.toHaveBeenCalled()
    })
})
