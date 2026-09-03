import { describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatUpsert: vi.fn(),
    resolveContact: vi.fn(),
    ensureLink: vi.fn(),
}))

// These mocks are intentionally unused by the retired route. They turn any
// accidental restoration of the old write path into an explicit regression.
vi.mock('@/lib/prisma', () => ({
    prisma: { chat: { upsert: mocks.chatUpsert } },
}))
vi.mock('@/modules/contacts/public/v1', () => ({
    resolveChannelContactOperationV1: mocks.resolveContact,
}))
vi.mock('@/modules/messaging/public/v1', () => ({
    ensureConversationContactLinkV1: mocks.ensureLink,
}))

import { POST } from './route'

describe('legacy start-chat endpoint', () => {
    test('fails closed without resolving or mutating a provider conversation', async () => {
        const request = new Request('http://localhost/api/messages/start-chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                driverId: 'driver-b',
                channel: 'telegram',
                externalChatId: 'peer-owned-by-a',
                providerAccountId: 'caller-selected-account',
            }),
        })

        const response = await POST(request)

        expect(response.status).toBe(409)
        await expect(response.json()).resolves.toMatchObject({
            error: 'PROVIDER_IDENTITY_REQUIRED',
        })
        expect(mocks.chatUpsert).not.toHaveBeenCalled()
        expect(mocks.resolveContact).not.toHaveBeenCalled()
        expect(mocks.ensureLink).not.toHaveBeenCalled()
    })
})
