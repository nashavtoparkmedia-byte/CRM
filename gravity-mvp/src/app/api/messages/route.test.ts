import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ send: vi.fn() }))
vi.mock('@/lib/MessageService', () => ({ MessageService: { send: mocks.send, getMessages: vi.fn() } }))

import { POST } from './route'

const request = (body: Record<string, unknown> = { chatId: 'chat-1', content: 'hi', clientMessageId: 'cmid-1' }) =>
    new Request('http://localhost/api/messages', { method: 'POST', body: JSON.stringify(body) }) as never

const refusal = (code: string, outcome: string, message: string) =>
    Object.assign(new Error(message), { name: 'ChannelDeliveryErrorV1', deliveryOutcome: outcome, deliveryErrorCode: code })

describe('POST /api/messages', () => {
    beforeEach(() => { mocks.send.mockReset() })

    test('answers a standing Contacts restriction with 403 and a stable code', async () => {
        mocks.send.mockImplementation(async () => { throw refusal('MESSAGING_CONTACT_PERMISSION_REFUSED', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_all') })
        const response = await POST(request())
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ code: 'CONTACT_COMMUNICATION_RESTRICTED', error: 'Связь с этим контактом ограничена: сообщение не отправлено' })
    })

    test('answers an unknown or archived Contact as unavailable for contact, not as a server error', async () => {
        mocks.send.mockImplementation(async () => { throw refusal('MESSAGING_CONTACT_PERMISSION_REFUSED', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED:contact_archived') })
        const response = await POST(request())
        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({ code: 'CONTACT_COMMUNICATION_RESTRICTED', error: 'Контакт недоступен для связи: сообщение не отправлено' })
    })

    test('answers a temporarily unavailable permission with 503, retry later', async () => {
        mocks.send.mockImplementation(async () => { throw refusal('MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED', 'safe_to_redeliver', 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:lineage_unsafe') })
        const response = await POST(request())
        expect(response.status).toBe(503)
        expect(await response.json()).toMatchObject({ code: 'CONTACT_COMMUNICATION_PERMISSION_UNAVAILABLE' })
    })

    test('refuses an operator send in the SendToContact id namespace', async () => {
        mocks.send.mockImplementation(async () => { throw new Error('MESSAGING_SEND_TO_CONTACT_NAMESPACE_RESERVED') })
        const response = await POST(request({ chatId: 'chat-1', content: 'hi', clientMessageId: 'stc:forged' }))
        expect(response.status).toBe(400)
        expect(await response.json()).toMatchObject({ code: 'CLIENT_MESSAGE_ID_RESERVED' })
    })

    test('keeps every other failure exactly as before', async () => {
        mocks.send.mockImplementation(async () => { throw new Error('Chat with ID chat-1 not found') })
        const response = await POST(request())
        expect(response.status).toBe(500)
        expect(await response.json()).toEqual({ error: 'Chat with ID chat-1 not found' })
    })
})
