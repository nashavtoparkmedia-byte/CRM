import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    prepareIdentity: vi.fn(),
    assertMaxTransport: vi.fn(),
    activeTelegramCarriers: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    prepareContactConversationIdentityV1: mocks.prepareIdentity,
}))
vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ assertTransportBinding: mocks.assertMaxTransport }),
}))
vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    activeTelegramCarrierIdsV1: mocks.activeTelegramCarriers,
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

    test('declines to assert a transport for a legacy unbound Telegram conversation', async () => {
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'telegram', externalId: '42',
                providerAccountId: null, providerAliasValues: [],
            },
        })
        // 58 of 167 production Telegram conversations carry no connection and none
        // can ever gain one. This capability does not invent a transport for them:
        // it returns null and leaves routing to the Telegram transport owner,
        // which this composition layer deliberately cannot see. Every ownership
        // guard below still ran.
        const unbound = { ...telegramChat('private'), metadata: { chatKind: 'private' } }

        await expect(prepareOutboundConversationV1(unbound)).resolves.toMatchObject({
            connectionId: null,
            target: '42',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
        })
    })

    test('still rejects a requested transport that disagrees with a bound conversation', async () => {
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'telegram', externalId: '42',
                providerAccountId: null, providerAliasValues: [],
            },
        })

        await expect(prepareOutboundConversationV1(telegramChat('private'), 'telegram-connection-other'))
            .rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_MISMATCH')
    })
})

// The production MAX topology: the Chat is linked to the identity whose externalId is the
// conversation key, while the peer who speaks in it is a sibling identity of the same
// Contact, recorded in metadata.senderId. Addressing the linked identity sends to the wrong
// row, and because the two externalIds differ it refused to send at all. The peer is known
// here only as a provider id, so Contacts is asked for it by that id and applies every gate
// it already owns; this layer adds no sendability policy of its own.
describe('outbound MAX peer addressing', () => {
    // exactly the shape of production C4
    const peerChat = {
        id: 'chat-max-c4',
        contactId: 'contact-c4',
        contactIdentityId: 'identity-chat-key',
        channel: 'max',
        externalChatId: '902454841098',
        chatType: 'private',
        metadata: {
            chatKind: 'private',
            senderId: '902264026154',
            providerAccountId: 'max-account-1',
            connectionId: 'max_scraper',
        },
    }
    const readyPeer = {
        status: 'ready',
        contact: { id: 'contact-c4' },
        identity: {
            id: 'identity-peer',
            channel: 'max',
            externalId: '902264026154',
            providerAccountId: 'max-account-1',
            providerAliasValues: [],
        },
    }

    beforeEach(() => {
        vi.clearAllMocks()
        mocks.prepareIdentity.mockResolvedValue(readyPeer)
    })

    test('addresses the peer by its exact provider id and sends as that identity', async () => {
        const prepared = await prepareOutboundConversationV1(peerChat)

        // Contacts is asked for the peer, never for the conversation's linked identity, and
        // the two selector axes are mutually exclusive by contract.
        expect(mocks.prepareIdentity).toHaveBeenCalledWith(expect.objectContaining({
            contactId: 'contact-c4',
            channel: 'max',
            identityId: null,
            identityExternalId: '902264026154',
            phoneId: null,
            purpose: 'send_in_bound_conversation',
        }))
        // The send-authorized identity and the provider target must name the SAME identity:
        // MessageService pairs them when it records reachability after a delivery.
        expect(prepared.contactIdentityId).toBe('identity-peer')
        expect(prepared.identityTarget).toBe('902264026154')
    })

    test.each([
        ['the peer belongs to another Contact', 'identity_not_found'],
        ['the peer is inactive', 'identity_not_found'],
        ['the peer does not exist', 'identity_not_found'],
        ['the peer carries an open conflict', 'identity_conflicted'],
        ['the peer is not reachable for this purpose', 'identity_unreachable'],
    ])('fails closed when %s', async (_label, status) => {
        mocks.prepareIdentity.mockResolvedValue({ status })

        await expect(prepareOutboundConversationV1(peerChat))
            .rejects.toThrow(`CONTACT_CONVERSATION_IDENTITY_NOT_SENDABLE:${status}`)
        expect(mocks.assertMaxTransport).not.toHaveBeenCalled()
    })

    test('refuses a MAX conversation that records no peer at all', async () => {
        const noPeer = { ...peerChat, metadata: { ...peerChat.metadata, senderId: undefined } }

        await expect(prepareOutboundConversationV1(noPeer))
            .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
        // refused before Contacts is consulted, so no conversation key is ever addressed
        expect(mocks.prepareIdentity).not.toHaveBeenCalled()
    })

    test('leaves the Telegram selector on the conversation identity', async () => {
        mocks.prepareIdentity.mockResolvedValue({
            status: 'ready',
            contact: { id: 'contact-1' },
            identity: {
                id: 'identity-1', channel: 'telegram', externalId: '42',
                providerAccountId: null, providerAliasValues: [],
            },
        })

        const prepared = await prepareOutboundConversationV1(telegramChat('private'))

        expect(mocks.prepareIdentity).toHaveBeenCalledWith(expect.objectContaining({
            identityId: 'identity-1',
            identityExternalId: null,
        }))
        expect(prepared.contactIdentityId).toBe('identity-1')
    })
})
