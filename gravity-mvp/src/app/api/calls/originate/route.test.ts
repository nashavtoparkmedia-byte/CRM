import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/modules/calling/public/v1/manual-call-handler', () => ({
    startManualCallV1: vi.fn(),
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: vi.fn() }))

import { startManualCallV1 } from '@/modules/calling/public/v1/manual-call-handler'
import { operationalLogV1 } from '@/infrastructure/operations/operational-log'
import { POST } from './route'

const start = vi.mocked(startManualCallV1)

function request(body: unknown, options: { origin?: string; contentType?: string } = {}) {
    const headers = new Headers()
    headers.set('host', 'crm.example')
    headers.set('origin', options.origin ?? 'https://crm.example')
    headers.set('content-type', options.contentType ?? 'application/json')
    return new NextRequest('https://crm.example/api/calls/originate', {
        method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body),
    })
}

const body = { requestId: '6f1c2b0a-9d1e-4a55-b1a2-0c3d4e5f6a7b', contactId: 'contact-1', phoneId: 'phone-1' }

describe('POST /api/calls/originate', () => {
    beforeEach(() => { start.mockReset(); vi.mocked(operationalLogV1).mockReset() })

    it.each([
        ['phoneNumber', { ...body, phoneNumber: '+79990000000' }],
        ['phoneNumber alone (the legacy body)', { phoneNumber: '+79990000000' }],
        ['phone', { ...body, phone: '+79990000000' }],
    ])('refuses a client-supplied %s before any policy runs', async (_name, payload) => {
        const response = await POST(request(payload))
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({ error: 'phone_number_not_accepted' })
        expect(start).not.toHaveBeenCalled()
    })

    it('requires a JSON mutation from the same origin', async () => {
        expect((await POST(request(body, { contentType: 'text/plain' }))).status).toBe(415)
        expect((await POST(request(body, { origin: 'https://evil.example' }))).status).toBe(403)
        expect(start).not.toHaveBeenCalled()
    })

    it('passes exactly the Contact, its phone id and the requestId to Calling', async () => {
        start.mockResolvedValue({ contract: 'calling.StartManualCallResult.v1', status: 'admitted', callId: 'manual_1', fsUuid: 'uuid-1', replay: false })
        const response = await POST(request(body))
        expect(start).toHaveBeenCalledWith({ contract: 'calling.StartManualCallCommand.v1', ...body })
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ ok: true, callId: 'manual_1', fsUuid: 'uuid-1', replay: false })
    })

    it.each([
        ['staff_not_authenticated', 401], ['staff_not_authorized', 403], ['voice_denied', 403], ['all_denied', 403],
        ['contact_unknown', 403], ['no_verified_number', 403], ['busy', 409], ['request_conflict', 409],
        ['permission_unavailable', 503], ['provider_unavailable', 503], ['contact_unavailable', 503],
    ] as const)('maps the refusal %s to HTTP %i', async (reason, status) => {
        start.mockResolvedValue({ contract: 'calling.StartManualCallResult.v1', status: 'refused', reason, retryable: false })
        const response = await POST(request(body))
        expect(response.status).toBe(status)
        expect(await response.json()).toEqual({ error: reason, retryable: false })
    })

    it('reports an unknown dial outcome as 202 indeterminate', async () => {
        start.mockResolvedValue({ contract: 'calling.StartManualCallResult.v1', status: 'indeterminate', callId: 'manual_1' })
        const response = await POST(request(body))
        expect(response.status).toBe(202)
        expect(await response.json()).toEqual({ ok: false, status: 'indeterminate', callId: 'manual_1' })
    })

    it('never logs a phone number', async () => {
        start.mockResolvedValue({ contract: 'calling.StartManualCallResult.v1', status: 'refused', reason: 'voice_denied', retryable: false })
        await POST(request(body))
        await POST(request({ ...body, phoneNumber: '+79990000000' }))
        expect(JSON.stringify(vi.mocked(operationalLogV1).mock.calls)).not.toMatch(/\+?7999|\+7916|phone-1/u)
    })
})
