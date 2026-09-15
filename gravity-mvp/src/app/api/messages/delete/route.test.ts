import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    messageFindUnique: vi.fn(),
    messageDelete: vi.fn(),
    prepareOutbound: vi.fn(),
    maxDelete: vi.fn(),
    broadcast: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        message: {
            findUnique: mocks.messageFindUnique,
            delete: mocks.messageDelete,
        },
    },
}))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ deleteMessage: mocks.maxDelete }),
}))

import { POST } from './route'

function request(deleteForEveryone = true) {
    return new Request('http://localhost/api/messages/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messageId: 'message-1', deleteForEveryone }),
    }) as never
}

function message() {
    return {
        id: 'message-1',
        chatId: 'chat-1',
        channel: 'max',
        externalId: 'provider-message-1',
        chat: {
            id: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            channel: 'max',
            externalChatId: 'provider-chat-1',
            chatType: 'private',
            metadata: {
                providerAccountId: 'max-account-1',
                connectionId: 'max-connection-1',
                senderId: 'sender-1',
            },
        },
    }
}

describe('message deletion identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.messageFindUnique.mockResolvedValue(message())
        mocks.prepareOutbound.mockResolvedValue({
            chatId: 'chat-1',
            channel: 'max',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'max-account-1',
            connectionId: 'max-connection-1',
            identityTarget: 'sender-1',
            target: 'provider-chat-1',
            isMaxPersonal: false,
        })
        mocks.maxDelete.mockResolvedValue(undefined)
        mocks.messageDelete.mockResolvedValue({})
    })

    test('deletes for everyone only through the exact account-bound conversation', async () => {
        const response = await POST(request())

        expect(response.status).toBe(200)
        expect(mocks.maxDelete).toHaveBeenCalledWith({
            chatId: 'provider-chat-1',
            messageId: 'provider-message-1',
            providerAccountId: 'max-account-1',
            connectionId: 'max-connection-1',
            isPersonal: false,
        })
        expect(mocks.messageDelete).toHaveBeenCalledWith({ where: { id: 'message-1' } })
        expect(mocks.maxDelete.mock.invocationCallOrder[0])
            .toBeLessThan(mocks.messageDelete.mock.invocationCallOrder[0])
    })

    test('does not mutate provider or database when identity preflight rejects', async () => {
        mocks.prepareOutbound.mockRejectedValue(new Error('CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE'))

        const response = await POST(request())

        expect(response.status).toBe(500)
        expect(mocks.maxDelete).not.toHaveBeenCalled()
        expect(mocks.messageDelete).not.toHaveBeenCalled()
    })
})
