import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    messageCreate: vi.fn(),
    prepareOutbound: vi.fn(),
    maxSendMedia: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findUnique: mocks.chatFindUnique, update: mocks.chatUpdate },
        message: { create: mocks.messageCreate },
    },
}))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ sendMedia: mocks.maxSendMedia }),
}))

import { POST } from './route'

const chat = {
    id: 'chat-1',
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    channel: 'max',
    externalChatId: 'max:spoofed-peer',
    chatType: 'private',
    metadata: { providerAccountId: 'spoofed-account', connectionId: 'spoofed-connection' },
}

function request() {
    return new NextRequest('https://crm.example/api/messages/send-image', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chatId: 'chat-1',
            base64: 'ZmFrZQ==',
            filename: 'photo.png',
            mimeType: 'image/png',
            caption: 'caption',
        }),
    })
}

describe('POST /api/messages/send-image outbound identity preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.chatFindUnique.mockResolvedValue(chat)
        mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
        mocks.chatUpdate.mockResolvedValue({})
        mocks.maxSendMedia.mockResolvedValue({ externalId: 'max-message-1' })
        vi.stubGlobal('fetch', vi.fn())
    })

    afterEach(() => vi.unstubAllGlobals())

    test('fails before provider or database mutation when the identity is unproven', async () => {
        mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'))

        const response = await POST(request())

        expect(response.status).toBe(500)
        expect(mocks.maxSendMedia).not.toHaveBeenCalled()
        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.chatUpdate).not.toHaveBeenCalled()
    })

    test('uses the MAX owner capability with only the prepared peer/account/transport', async () => {
        mocks.prepareOutbound.mockResolvedValue({
            chatId: 'chat-1',
            channel: 'max',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'account-exact',
            connectionId: 'connection-exact',
            identityTarget: 'peer-exact',
            target: 'peer-exact',
            isMaxPersonal: false,
        })

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat)
        expect(mocks.maxSendMedia).toHaveBeenCalledWith({
            chatId: 'peer-exact',
            base64: 'ZmFrZQ==',
            filename: 'photo.png',
            mimeType: 'image/png',
            caption: 'caption',
            mediaType: 'image',
            providerAccountId: 'account-exact',
            connectionId: 'connection-exact',
            isPersonal: false,
        })
        expect(fetch).not.toHaveBeenCalled()
    })
})
