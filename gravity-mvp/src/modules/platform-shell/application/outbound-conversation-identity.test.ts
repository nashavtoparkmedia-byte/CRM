import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    prepareIdentity: vi.fn(),
    assertMaxTransport: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    prepareContactConversationIdentityV1: mocks.prepareIdentity,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: mocks.assertMaxTransport }),
}))

import { prepareOutboundConversationV1 } from './outbound-conversation-identity'

function maxChat(chatKind: 'private' | 'group' | 'unknown') {
    return {
        id: 'chat-max-1',
        contactId: 'contact-1',
        contactIdentityId: 'identity-1',
        channel: 'max',
        externalChatId: 'max-room-42',
        chatType: chatKind === 'private' ? 'private' : chatKind,
        metadata: {
            chatKind,
            senderId: 'max-peer-42',
            providerAccountId: 'max-account-1',
            connectionId: 'max_scraper',
        },
    }
}

function telegramChat(chatKind: 'private' | 'group') {
    return {
        id: 'chat-telegram-1',
        contactId: 'contact-1',
        contactIdentityId: 'identity-1',
        channel: 'telegram',
        externalChatId: 'telegram:42',
        chatType: chatKind,
        metadata: {
            chatKind,
            providerAccountId: 'telegram-account-1',
            connectionId: 'telegram-connection-1',
        },
    }
}

describe('outbound person-conversation classification', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1' },
            identity: {
                id: 'identity-1',
                channel: 'max',
                externalId: 'max-peer-42',
                providerAccountId: 'max-account-1',
                providerAliasValues: [],
            },
        })
    })

    test.each(['unknown', 'group'] as const)(
        'rejects a confirmed MAX identity on a %s room before transport admission',
        async chatKind => {
            await expect(prepareOutboundConversationV1(maxChat(chatKind)))
                .rejects.toThrow('CONTACT_CONVERSATION_NOT_PRIVATE')
            expect(mocks.assertMaxTransport).not.toHaveBeenCalled()
        },
    )

    test('admits only an exact private MAX person conversation', async () => {
        await expect(prepareOutboundConversationV1(maxChat('private'))).resolves.toMatchObject({
            chatId: 'chat-max-1',
            channel: 'max',
            identityTarget: 'max-peer-42',
            target: 'max-room-42',
        })
        expect(mocks.assertMaxTransport).toHaveBeenCalledOnce()
    })

    test('rejects a Telegram group even when its identity is reachable', async () => {
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1' },
            identity: {
                id: 'identity-1',
                channel: 'telegram',
                externalId: '42',
                providerAccountId: 'telegram-account-1',
                providerAliasValues: [],
            },
        })

        await expect(prepareOutboundConversationV1(telegramChat('group')))
            .rejects.toThrow('CONTACT_CONVERSATION_NOT_PRIVATE')
    })

    test('admits an exact private Telegram Chat', async () => {
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1' },
            identity: {
                id: 'identity-1',
                channel: 'telegram',
                externalId: '42',
                providerAccountId: 'telegram-account-1',
                providerAliasValues: [],
            },
        })

        await expect(prepareOutboundConversationV1(telegramChat('private')))
            .resolves.toMatchObject({
                chatId: 'chat-telegram-1',
                channel: 'telegram',
                target: '42',
                connectionId: 'telegram-connection-1',
            })
    })
})
