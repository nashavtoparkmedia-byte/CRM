import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    messageFindUnique: vi.fn(),
    prepareOutbound: vi.fn(),
    patchMetadata: vi.fn(),
    maxSendReaction: vi.fn(),
    telegramSendReaction: vi.fn(),
    whatsAppSendReaction: vi.fn(),
    broadcast: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: { message: { findUnique: mocks.messageFindUnique } },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/modules/messaging/public/v1', () => ({
    patchMessageMetadataV1: mocks.patchMetadata,
}))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ sendReaction: mocks.maxSendReaction }),
    getTelegramChannelDeliveryV1: () => ({ sendReaction: mocks.telegramSendReaction }),
    getWhatsAppChannelDeliveryV1: () => ({ sendReaction: mocks.whatsAppSendReaction }),
}))

import { POST } from './route'

function message(channel: 'telegram' | 'whatsapp' | 'max') {
    return {
        id: 'message-1',
        metadata: {},
        externalId: channel === 'telegram'
            ? 'telegram:account-exact:peer-exact:301'
            : 'd301abcd',
        channel,
        chatId: 'chat-1',
        chat: {
            id: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            channel,
            externalChatId: `${channel}:spoofed-peer`,
            chatType: 'private',
            metadata: {
                providerAccountId: 'spoofed-account',
                connectionId: 'spoofed-connection',
            },
        },
    }
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

function request() {
    return new NextRequest('https://crm.example/api/messages/reaction', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'message-1', emoji: '👍' }),
    })
}

describe('POST /api/messages/reaction outbound identity preflight', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.patchMetadata.mockResolvedValue({})
        mocks.telegramSendReaction.mockResolvedValue(undefined)
        mocks.whatsAppSendReaction.mockResolvedValue(undefined)
        mocks.maxSendReaction.mockResolvedValue({ reactionConfirmed: true })
    })

    test('does not mutate reaction state or call a provider without identity proof', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('max'))
        mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_IDENTITY_REQUIRED'))

        const response = await POST(request())

        expect(response.status).toBe(500)
        expect(mocks.patchMetadata).not.toHaveBeenCalled()
        expect(mocks.maxSendReaction).not.toHaveBeenCalled()
        expect(mocks.telegramSendReaction).not.toHaveBeenCalled()
        expect(mocks.whatsAppSendReaction).not.toHaveBeenCalled()
    })

    test('answers a Contacts permission refusal with a stable code, before any provider or database mutation', async () => {
        const refusal = (code: string, outcome: string, message: string) =>
            Object.assign(new Error(message), { name: 'ChannelDeliveryErrorV1', deliveryOutcome: outcome, deliveryErrorCode: code })
        mocks.messageFindUnique.mockResolvedValue(message('max'))
        mocks.prepareOutbound.mockRejectedValueOnce(refusal('MESSAGING_CONTACT_PERMISSION_REFUSED', 'terminal', 'MESSAGING_CONTACT_PERMISSION_REFUSED:restricted_message'))
        const restricted = await POST(request())
        expect(restricted.status).toBe(403)
        expect(await restricted.json()).toMatchObject({ code: 'CONTACT_COMMUNICATION_RESTRICTED', error: 'Связь с этим контактом ограничена: сообщение не отправлено' })

        mocks.prepareOutbound.mockRejectedValueOnce(refusal('MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED', 'safe_to_redeliver', 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:policy_unavailable'))
        const unavailable = await POST(request())
        expect(unavailable.status).toBe(503)
        expect(await unavailable.json()).toMatchObject({ code: 'CONTACT_COMMUNICATION_PERMISSION_UNAVAILABLE' })
        expect(mocks.patchMetadata).not.toHaveBeenCalled()
        expect(mocks.maxSendReaction).not.toHaveBeenCalled()
    })

    test('uses the prepared WhatsApp peer and transport', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('whatsapp'))
        mocks.prepareOutbound.mockResolvedValue(prepared('whatsapp'))

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.whatsAppSendReaction).toHaveBeenCalledWith({
            connectionId: 'connection-exact',
            chatId: 'peer-exact',
            messageId: 'd301abcd',
            emoji: '👍',
            remove: false,
        })
        expect(mocks.patchMetadata).toHaveBeenCalledOnce()
    })

    test('uses the prepared Telegram peer and transport', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('telegram'))
        mocks.prepareOutbound.mockResolvedValue(prepared('telegram'))

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.telegramSendReaction).toHaveBeenCalledWith({
            connectionId: 'connection-exact',
            internalChatId: 'chat-1',
            providerAccountId: 'account-exact',
            identityTarget: 'peer-exact',
            chatId: 'peer-exact',
            messageId: 'telegram:account-exact:peer-exact:301',
            emoji: '👍',
            remove: false,
        })
    })

    test('uses the prepared MAX peer and exact account-to-transport binding', async () => {
        mocks.messageFindUnique.mockResolvedValue(message('max'))
        mocks.prepareOutbound.mockResolvedValue(prepared('max'))

        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.maxSendReaction).toHaveBeenCalledWith({
            chatId: 'peer-exact',
            messageId: 'd301abcd',
            emoji: '👍',
            remove: false,
            providerAccountId: 'account-exact',
            connectionId: 'connection-exact',
            isPersonal: false,
        })
        expect(mocks.patchMetadata).toHaveBeenCalledOnce()
    })
})
