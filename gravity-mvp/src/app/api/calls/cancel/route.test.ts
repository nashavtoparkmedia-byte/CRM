import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/modules/calling/public/v1/manual-call-handler', () => ({
    cancelManualCallV1: vi.fn(),
}))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: vi.fn() }))

import { cancelManualCallV1 } from '@/modules/calling/public/v1/manual-call-handler'
import { POST } from './route'

const cancel = vi.mocked(cancelManualCallV1)
const FS_UUID = '5f0c1d2e-3a4b-5c6d-8e7f-001122334455'

function request(body: unknown, options: { origin?: string; contentType?: string } = {}) {
    const headers = new Headers()
    headers.set('host', 'crm.example')
    headers.set('origin', options.origin ?? 'https://crm.example')
    headers.set('content-type', options.contentType ?? 'application/json')
    return new NextRequest('https://crm.example/api/calls/cancel', { method: 'POST', headers, body: JSON.stringify(body) })
}

describe('POST /api/calls/cancel', () => {
    beforeEach(() => cancel.mockReset())

    it('requires a JSON mutation from the same origin', async () => {
        expect((await POST(request({ fsUuid: FS_UUID }, { contentType: 'text/plain' }))).status).toBe(415)
        expect((await POST(request({ fsUuid: FS_UUID }, { origin: 'https://evil.example' }))).status).toBe(403)
        expect(cancel).not.toHaveBeenCalled()
    })

    it('hands only the channel uuid to Calling, which checks the employee and the call', async () => {
        cancel.mockResolvedValue({ contract: 'calling.CancelManualCallResult.v1', status: 'cancelled' })
        const response = await POST(request({ fsUuid: FS_UUID }))
        expect(cancel).toHaveBeenCalledWith({ contract: 'calling.CancelManualCallCommand.v1', fsUuid: FS_UUID })
        expect(response.status).toBe(200)
    })

    it.each([
        ['staff_not_authenticated', 401], ['staff_not_authorized', 403], ['call_not_found', 404], ['call_not_active', 409], ['provider_unavailable', 503],
    ] as const)('maps %s to HTTP %i', async (reason, status) => {
        cancel.mockResolvedValue({ contract: 'calling.CancelManualCallResult.v1', status: 'refused', reason })
        expect((await POST(request({ fsUuid: FS_UUID }))).status).toBe(status)
    })
})
