import { describe, expect, test, vi } from 'vitest'

import {
    isOutboundRouteQuarantinedV1,
    prepareOutboundConversationV1,
    registerOutboundConversationPreparerV1,
} from './outbound-conversation-identity-runtime'

describe('Messaging outbound conversation identity runtime', () => {
    test('delegates the exact snapshot and requested transport to the composed Platform Shell proof', async () => {
        const prepared = {
            chatId: 'chat-1',
            channel: 'telegram' as const,
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            providerAccountId: 'account-1',
            connectionId: 'connection-1',
            identityTarget: 'peer-1',
            target: 'peer-1',
            isMaxPersonal: false,
        }
        const preparer = vi.fn().mockResolvedValue(prepared)
        const snapshot = {
            id: 'chat-1',
            contactId: 'contact-1',
            contactIdentityId: 'identity-1',
            channel: 'telegram',
            externalChatId: 'telegram:peer-1',
            metadata: { providerAccountId: 'account-1', connectionId: 'connection-1' },
        }
        const unregister = registerOutboundConversationPreparerV1(preparer)

        await expect(prepareOutboundConversationV1(snapshot, 'connection-1'))
            .resolves.toEqual(prepared)
        expect(preparer).toHaveBeenCalledWith(snapshot, 'connection-1')
        unregister()
        await expect(prepareOutboundConversationV1(snapshot))
            .rejects.toThrow('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    })
})

describe('outbound route quarantine after a detected transport collision', () => {
    const prepared = (chatId: string, channel: 'telegram' | 'whatsapp' | 'max') => ({
        chatId,
        channel,
        contactId: 'contact-1',
        contactIdentityId: `identity-${channel}`,
        providerAccountId: null,
        connectionId: `slot-${channel}`,
        identityTarget: 'peer',
        target: 'peer',
        isMaxPersonal: false,
    })
    const whatsappMismatch = {
        channel: 'whatsapp',
        reason: 'transport_mismatch',
        phase: 'live',
        incomingConnectionId: 'slot-y',
        existingConnectionId: 'slot-x',
        externalChatId: '79990000001@c.us',
        observedAt: '2026-09-15T00:00:00.000Z',
    }
    const whatsappChat = (audit: unknown[] | undefined, connectionId = 'slot-x') => ({
        id: 'chat-wa',
        contactId: 'contact-1',
        contactIdentityId: 'identity-whatsapp',
        channel: 'whatsapp',
        externalChatId: '79990000001@c.us',
        chatType: 'private',
        metadata: {
            connectionId,
            ...(audit ? { channelIdentityCollisionAudit: audit } : {}),
        },
    })

    test('a WhatsApp conversation whose bound slot was contradicted fails closed at the outbound port every provider mutation uses', async () => {
        // The peer was observed on slot-y while the conversation is bound to
        // slot-x. WhatsApp sends attest no account, so slot-x may now be paired
        // to a company number the peer never wrote to: the route fails closed
        // before any Contacts proof or provider call is attempted.
        const preparer = vi.fn()
        const unregister = registerOutboundConversationPreparerV1(preparer)
        try {
            await expect(prepareOutboundConversationV1(whatsappChat([whatsappMismatch])))
                .rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_COLLISION')
            await expect(prepareOutboundConversationV1(whatsappChat([whatsappMismatch]), 'slot-x'))
                .rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_COLLISION')
            expect(preparer).not.toHaveBeenCalled()
        } finally {
            unregister()
        }
    })

    test('the quarantine is confined to the collided route: the same person stays reachable elsewhere', async () => {
        const preparer = vi.fn(async (chat: { id?: unknown, channel?: unknown }) =>
            prepared(String(chat.id), chat.channel as 'telegram' | 'whatsapp' | 'max'))
        const unregister = registerOutboundConversationPreparerV1(preparer)
        try {
            await expect(prepareOutboundConversationV1(whatsappChat([whatsappMismatch])))
                .rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_COLLISION')
            // Another WhatsApp conversation with no collision of its own.
            await expect(prepareOutboundConversationV1({ ...whatsappChat(undefined, 'slot-y'), id: 'chat-wa-2' }))
                .resolves.toMatchObject({ chatId: 'chat-wa-2' })
            // The same Contact on Telegram.
            await expect(prepareOutboundConversationV1({
                id: 'chat-tg',
                contactId: 'contact-1',
                contactIdentityId: 'identity-telegram',
                channel: 'telegram',
                externalChatId: 'telegram:42',
                chatType: 'private',
                metadata: { chatKind: 'private', connectionId: 'slot-telegram' },
            })).resolves.toMatchObject({ chatId: 'chat-tg', channel: 'telegram' })
            expect(preparer).toHaveBeenCalledTimes(2)
        } finally {
            unregister()
        }
    })

    test('a historical WhatsApp mismatch entry without the contradicted slot still quarantines', () => {
        expect(isOutboundRouteQuarantinedV1(whatsappChat([{ ...whatsappMismatch, existingConnectionId: undefined }]))).toBe(true)
        expect(isOutboundRouteQuarantinedV1(whatsappChat([{ ...whatsappMismatch, existingConnectionId: '  ' }]))).toBe(true)
    })

    test('an entry about a different concrete binding, or no mismatch at all, does not quarantine', () => {
        expect(isOutboundRouteQuarantinedV1(whatsappChat([{ ...whatsappMismatch, existingConnectionId: 'slot-old' }]))).toBe(false)
        expect(isOutboundRouteQuarantinedV1(whatsappChat([{ ...whatsappMismatch, reason: 'transport_unbound' }]))).toBe(false)
        expect(isOutboundRouteQuarantinedV1(whatsappChat([]))).toBe(false)
        expect(isOutboundRouteQuarantinedV1(whatsappChat(undefined))).toBe(false)
    })

    test.each([
        ['telegram', 'transport_connection_mismatch'],
        ['max', 'provider_account_mismatch'],
        ['max', 'provider_account_unproven'],
    ] as const)('a %s %s audit does not quarantine a route whose send attests the live account', async (channel, reason) => {
        const preparer = vi.fn(async () => prepared(`chat-${channel}`, channel))
        const unregister = registerOutboundConversationPreparerV1(preparer)
        try {
            await expect(prepareOutboundConversationV1({
                id: `chat-${channel}`,
                contactId: 'contact-1',
                contactIdentityId: `identity-${channel}`,
                channel,
                externalChatId: channel === 'telegram' ? 'telegram:42' : 'max-room-42',
                chatType: 'private',
                metadata: {
                    chatKind: 'private',
                    connectionId: `slot-${channel}`,
                    channelIdentityCollisionAudit: [{ channel, reason }],
                },
            })).resolves.toMatchObject({ channel })
            expect(preparer).toHaveBeenCalledOnce()
        } finally {
            unregister()
        }
    })
})
