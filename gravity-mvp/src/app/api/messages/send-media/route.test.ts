import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    messageCreate: vi.fn(),
    messageFindUnique: vi.fn(),
    attachmentCreate: vi.fn(),
    prepareOutbound: vi.fn(),
    maxSendMedia: vi.fn(),
    telegramSendMedia: vi.fn(),
    whatsAppSendMedia: vi.fn(),
    broadcast: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findUnique: mocks.chatFindUnique, update: mocks.chatUpdate },
        message: { create: mocks.messageCreate, findUnique: mocks.messageFindUnique },
        messageAttachment: { create: mocks.attachmentCreate },
    },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ sendMedia: mocks.maxSendMedia }),
    getTelegramChannelDeliveryV1: () => ({ sendMedia: mocks.telegramSendMedia }),
    getWhatsAppChannelDeliveryV1: () => ({ sendMedia: mocks.whatsAppSendMedia }),
}))

import { POST } from './route'

const chat = {
    id: 'chat-1',
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    channel: 'telegram',
    externalChatId: 'telegram:spoofed-peer',
    chatType: 'private',
    metadata: { providerAccountId: 'spoofed-account', connectionId: 'spoofed-connection' },
}

function prepared(channel: 'telegram' | 'whatsapp' | 'max') {
    return {
        chatId: 'chat-1',
        channel,
        contactId: 'contact-1',
        contactIdentityId: 'identity-1',
        providerAccountId: 'account-exact',
        connectionId: 'connection-exact',
        identityTarget: 'peer-exact',
        target: 'peer-exact',
        isMaxPersonal: false,
    }
}

function request(extra: Record<string, unknown> = {}) {
    return new NextRequest('https://crm.example/api/messages/send-media', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            chatId: 'chat-1',
            base64: 'ZmFrZQ==',
            filename: 'evidence.bin',
            mimeType: 'application/octet-stream',
            caption: 'caption',
            ...extra,
        }),
    })
}

describe('POST /api/messages/send-media outbound identity preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.chatFindUnique.mockResolvedValue(chat)
        mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.attachmentCreate.mockResolvedValue({ id: 'attachment-1' })
        mocks.chatUpdate.mockResolvedValue({})
        mocks.maxSendMedia.mockResolvedValue({ externalId: 'max-message-1' })
        mocks.telegramSendMedia.mockResolvedValue({ success: true, externalId: 'telegram-message-1' })
        mocks.whatsAppSendMedia.mockResolvedValue({ externalId: 'whatsapp-message-1' })
    })

    test('fails closed before provider and database mutation when identity proof is missing', async () => {
        mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'))

        const response = await POST(request())

        expect(response.status).toBe(500)
        expect(mocks.maxSendMedia).not.toHaveBeenCalled()
        expect(mocks.telegramSendMedia).not.toHaveBeenCalled()
        expect(mocks.whatsAppSendMedia).not.toHaveBeenCalled()
        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.chatUpdate).not.toHaveBeenCalled()
    })

    test('routes Telegram media only through the prepared peer and transport', async () => {
        mocks.prepareOutbound.mockResolvedValue(prepared('telegram'))

        const response = await POST(request({ profileId: 'connection-exact' }))

        expect(response.status).toBe(200)
        expect(mocks.prepareOutbound).toHaveBeenCalledWith(chat, 'connection-exact')
        expect(mocks.telegramSendMedia).toHaveBeenCalledWith(expect.objectContaining({
            target: 'peer-exact',
            connectionId: 'connection-exact',
            internalChatId: 'chat-1',
            providerAccountId: 'account-exact',
            identityTarget: 'peer-exact',
        }))
        expect(mocks.telegramSendMedia).not.toHaveBeenCalledWith(expect.objectContaining({
            target: 'spoofed-peer',
        }))
    })

    test('routes WhatsApp media only through the prepared peer and transport', async () => {
        mocks.prepareOutbound.mockResolvedValue(prepared('whatsapp'))

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.whatsAppSendMedia).toHaveBeenCalledWith(expect.objectContaining({
            chatId: 'peer-exact',
            connectionId: 'connection-exact',
        }))
    })

    test('routes MAX media with the exact prepared account-to-transport binding', async () => {
        mocks.prepareOutbound.mockResolvedValue(prepared('max'))

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.maxSendMedia).toHaveBeenCalledWith(expect.objectContaining({
            chatId: 'peer-exact',
            providerAccountId: 'account-exact',
            connectionId: 'connection-exact',
            isPersonal: false,
        }))
        expect(mocks.maxSendMedia.mock.calls[0][0]).not.toHaveProperty('phone')
        expect(mocks.maxSendMedia.mock.calls[0][0]).not.toHaveProperty('uiChatId')
    })
})
