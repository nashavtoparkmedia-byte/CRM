import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatFindFirst: vi.fn(),
    chatCreate: vi.fn(),
    chatUpdate: vi.fn(),
    chatDelete: vi.fn(),
    messageFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageCreate: vi.fn(),
    messageUpdate: vi.fn(),
    messageUpdateMany: vi.fn(),
    queryRaw: vi.fn(),
    telegramSendText: vi.fn(),
    whatsAppSendText: vi.fn(),
    maxSendText: vi.fn(),
    maxAssertTransportBinding: vi.fn(),
    prepareIdentity: vi.fn(),
    outboundWorkflow: vi.fn(),
    recordReachability: vi.fn(),
    broadcast: vi.fn(),
    opsLog: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: mocks.chatFindUnique,
            findFirst: mocks.chatFindFirst,
            create: mocks.chatCreate,
            update: mocks.chatUpdate,
            delete: mocks.chatDelete,
        },
        message: {
            findUnique: mocks.messageFindUnique,
            findFirst: mocks.messageFindFirst,
            create: mocks.messageCreate,
            update: mocks.messageUpdate,
            updateMany: mocks.messageUpdateMany,
        },
        $queryRaw: mocks.queryRaw,
    },
}))

vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.telegramSendText }),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.whatsAppSendText }),
    getMaxChannelDeliveryV1: () => ({
        assertTransportBinding: mocks.maxAssertTransportBinding,
        sendText: mocks.maxSendText,
    }),
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: mocks.outboundWorkflow },
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    prepareContactConversationIdentityV1: mocks.prepareIdentity,
}))

vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))

vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: mocks.broadcast }))
vi.mock('@/infrastructure/operations/operational-log', () => ({ operationalLogV1: mocks.opsLog }))

import { MessageService } from './MessageService'
import {
    registerOutboundConversationPreparerV1,
} from '@/modules/messaging/public/v1/outbound-conversation-identity-runtime'
import {
    prepareOutboundConversationV1 as preparePlatformOutboundConversationV1,
} from '@/modules/platform-shell/public/v1/outbound-conversation-identity'

const PROVIDER_ACCOUNT = 'provider-account-b'
const TRANSPORT_CONNECTION = 'transport-connection-b'

type PreparedIdentityFixture = {
    status: 'ready' | 'identity_not_found'
    contact?: { id: string; displayName: string }
    identity?: {
        id: string
        channel: 'telegram' | 'whatsapp' | 'max'
        externalId: string
        providerAccountId: string | null
    }
}

const identityFixtures = new Map<string, PreparedIdentityFixture>()

function chat(channel: 'telegram' | 'whatsapp' | 'max', suppliedMetadata?: Record<string, unknown>) {
    const metadata: Record<string, unknown> = {
        ...(suppliedMetadata ?? {
            providerAccountId: PROVIDER_ACCOUNT,
            connectionId: channel === 'whatsapp' ? PROVIDER_ACCOUNT : TRANSPORT_CONNECTION,
            ...(channel === 'max' ? { senderId: 'opaque-user-42' } : {}),
        }),
        ...(
            (channel === 'max' || channel === 'telegram')
            && suppliedMetadata?.chatKind === undefined
                ? { chatKind: 'private' }
                : {}
        ),
    }
    const identityExternalId = channel === 'whatsapp'
        ? '79990001122@c.us'
        : 'opaque-user-42'
    const result = {
        id: 'chat-1',
        channel,
        externalChatId: channel === 'whatsapp'
            ? 'whatsapp:79990001122'
            : `${channel}:opaque-user-42`,
        chatType: channel === 'max' || channel === 'telegram' ? 'private' : null,
        metadata,
        contactId: 'contact-1',
        contactIdentityId: 'identity-1',
        driver: null,
    }
    identityFixtures.set('identity-1', {
        status: 'ready',
        contact: { id: 'contact-1', displayName: 'Contact' },
        identity: {
            id: 'identity-1',
            channel,
            externalId: channel === 'max' ? String(metadata.senderId ?? '') : identityExternalId,
            providerAccountId: String(
                metadata.providerAccountId
                ?? (channel === 'whatsapp' ? metadata.connectionId : ''),
            ) || null,
        },
    })
    return result
}

function failedMessage(channel: 'telegram' | 'whatsapp' | 'max') {
    return {
        id: 'message-1',
        chatId: 'chat-1',
        channel,
        content: 'retry me',
        clientMessageId: 'client-message-1',
        status: 'failed',
        updatedAt: new Date('2026-09-01T00:00:00.000Z'),
        metadata: {
            retryable: true,
            retryAttempt: 0,
            maxRetries: 3,
            lastFailedAt: '2020-01-01T00:00:00.000Z',
        },
        chat: chat(channel),
    }
}

describe('MessageService conversation transport routing', () => {
    let unregisterOutboundPreparer: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        identityFixtures.clear()
        mocks.prepareIdentity.mockImplementation(async (command: { identityId: string }) => (
            identityFixtures.get(command.identityId) ?? { status: 'identity_not_found' }
        ))
        mocks.messageCreate.mockResolvedValue({ id: 'message-created' })
        mocks.messageUpdate.mockResolvedValue({})
        mocks.messageUpdateMany.mockResolvedValue({ count: 1 })
        mocks.chatUpdate.mockResolvedValue({})
        mocks.telegramSendText.mockResolvedValue({ externalId: 'telegram-message-1' })
        mocks.whatsAppSendText.mockResolvedValue({ externalId: 'whatsapp-message-1' })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'delivered',
            externalId: 'max-message-1',
            resolvedChatId: null,
        })
        mocks.outboundWorkflow.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({
            outcome: 'updated',
            identityId: 'identity-1',
            status: 'confirmed',
        })
        vi.stubGlobal('fetch', vi.fn())
        unregisterOutboundPreparer = registerOutboundConversationPreparerV1(
            preparePlatformOutboundConversationV1,
        )
    })

    afterEach(() => {
        unregisterOutboundPreparer?.()
        vi.unstubAllGlobals()
    })

    test('routes Telegram send through the conversation-bound transport, never the provider account or global default', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram'))

        await expect(MessageService.send('chat-1', 'hello', 'telegram')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })

        expect(mocks.telegramSendText).toHaveBeenCalledWith(expect.objectContaining({
            target: 'opaque-user-42',
            connectionId: TRANSPORT_CONNECTION,
        }))
        expect(mocks.queryRaw).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
        expect(mocks.recordReachability).toHaveBeenCalledWith({
            identityId: 'identity-1',
            contactId: 'contact-1',
            channel: 'telegram',
            providerAccountId: PROVIDER_ACCOUNT,
            providerTargetId: 'opaque-user-42',
            status: 'confirmed',
        })
    })

    test('rejects a caller-selected connection that conflicts with the conversation-bound transport', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram'))

        await expect(MessageService.send(
            'chat-1',
            'hello',
            'telegram',
            'transport-connection-a',
        )).rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_MISMATCH')

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.telegramSendText).not.toHaveBeenCalled()
        expect(mocks.queryRaw).not.toHaveBeenCalled()
    })

    test('rejects cross-channel switching for an identity-backed chat before creating another Chat', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram'))

        await expect(MessageService.send('chat-1', 'hello', 'whatsapp'))
            .rejects.toThrow('CONTACT_CONVERSATION_CHANNEL_MISMATCH')

        expect(mocks.chatFindFirst).not.toHaveBeenCalled()
        expect(mocks.chatCreate).not.toHaveBeenCalled()
        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.whatsAppSendText).not.toHaveBeenCalled()
    })

    test('does not fall back to a Telegram bot when bound-transport delivery fails', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram'))
        mocks.telegramSendText.mockRejectedValue(new Error('bound connection unavailable'))

        await expect(MessageService.send('chat-1', 'hello', 'telegram')).resolves.toMatchObject({
            success: false,
            status: 'failed',
            error: 'bound connection unavailable',
        })

        expect(mocks.telegramSendText).toHaveBeenCalledWith(expect.objectContaining({
            connectionId: TRANSPORT_CONNECTION,
        }))
        expect(fetch).not.toHaveBeenCalled()
        expect(mocks.queryRaw).not.toHaveBeenCalled()
        expect(mocks.recordReachability).not.toHaveBeenCalled()
    })

    test('routes MAX send through a non-personal conversation-bound transport', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('max'))

        await expect(MessageService.send('chat-1', 'hello', 'max')).resolves.toMatchObject({
            success: true,
        })

        expect(mocks.maxSendText).toHaveBeenCalledWith(expect.objectContaining({
            target: 'opaque-user-42',
            options: expect.objectContaining({
                providerAccountId: PROVIDER_ACCOUNT,
                isPersonal: false,
                connectionId: TRANSPORT_CONNECTION,
            }),
        }))
    })

    test('scopes a MAX quoted-message lookup to the exact conversation', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('max'))
        mocks.messageFindFirst.mockResolvedValue(null)

        await MessageService.send(
            'chat-1',
            'hello',
            'max',
            undefined,
            undefined,
            'provider-message-from-another-chat',
        )

        expect(mocks.messageFindFirst).toHaveBeenCalledWith(expect.objectContaining({
            where: {
                chatId: 'chat-1',
                OR: [
                    { id: 'provider-message-from-another-chat' },
                    { externalId: 'provider-message-from-another-chat' },
                ],
            },
        }))
        expect(mocks.maxSendText).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({
                quotedMsgId: undefined,
                quotedText: undefined,
            }),
        }))
    })

    test('routes WhatsApp send through the conversation-bound transport', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('whatsapp'))

        await expect(MessageService.send('chat-1', 'hello', 'whatsapp')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })

        expect(mocks.whatsAppSendText).toHaveBeenCalledWith(expect.objectContaining({
            connectionId: PROVIDER_ACCOUNT,
            chatId: '79990001122@c.us',
        }))
    })

    test('accepts an exact live-shaped WhatsApp phone JID using connectionId as its account scope', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('whatsapp', {
            connectionId: PROVIDER_ACCOUNT,
        }))

        await expect(MessageService.send('chat-1', 'hello', 'whatsapp')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })
        expect(mocks.whatsAppSendText).toHaveBeenCalledWith(expect.objectContaining({
            connectionId: PROVIDER_ACCOUNT,
            chatId: '79990001122@c.us',
        }))
    })

    test('accepts only the exact persisted WhatsApp LID peer', async () => {
        const waChat = chat('whatsapp', { connectionId: PROVIDER_ACCOUNT })
        waChat.externalChatId = '165313509372005@lid'
        identityFixtures.set('identity-1', {
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1',
                channel: 'whatsapp',
                externalId: '165313509372005@lid',
                providerAccountId: PROVIDER_ACCOUNT,
            },
        })
        mocks.chatFindUnique.mockResolvedValue(waChat)

        await expect(MessageService.send('chat-1', 'hello', 'whatsapp')).resolves.toMatchObject({
            success: true,
        })
        expect(mocks.whatsAppSendText).toHaveBeenCalledWith(expect.objectContaining({
            chatId: '165313509372005@lid',
        }))

        waChat.externalChatId = '265313509372005@lid'
        mocks.chatFindUnique.mockResolvedValue(waChat)
        await expect(MessageService.send('chat-1', 'hello', 'whatsapp'))
            .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH')
    })

    test('requires a persisted ContactIdentity even for a legacy person Chat', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            ...chat('telegram'),
            contactIdentityId: null,
        })

        await expect(MessageService.send('chat-1', 'hello', 'telegram'))
            .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_REQUIRED')
        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.telegramSendText).not.toHaveBeenCalled()
        expect(mocks.queryRaw).not.toHaveBeenCalled()
    })

    test.each(['telegram', 'whatsapp', 'max'] as const)(
        'routes %s retry through the original conversation-bound transport',
        async channel => {
            mocks.messageFindUnique.mockResolvedValue(failedMessage(channel))

            await expect(MessageService.retrySend('message-1')).resolves.toEqual({
                success: true,
                error: undefined,
            })

            if (channel === 'telegram') {
                expect(mocks.telegramSendText).toHaveBeenCalledWith(expect.objectContaining({
                    connectionId: TRANSPORT_CONNECTION,
                }))
                expect(mocks.queryRaw).not.toHaveBeenCalled()
            } else if (channel === 'whatsapp') {
                expect(mocks.whatsAppSendText).toHaveBeenCalledWith(expect.objectContaining({
                    connectionId: PROVIDER_ACCOUNT,
                }))
            } else {
                expect(mocks.maxSendText).toHaveBeenCalledWith(expect.objectContaining({
                    options: expect.objectContaining({
                        isPersonal: false,
                        connectionId: TRANSPORT_CONNECTION,
                    }),
                }))
            }
            expect(mocks.recordReachability).toHaveBeenCalledWith(expect.objectContaining({
                identityId: 'identity-1',
                contactId: 'contact-1',
                channel,
                status: 'confirmed',
            }))
        },
    )

    test('atomically admits only one concurrent retry for the same failed row version', async () => {
        const retry = failedMessage('max')
        mocks.messageFindUnique.mockResolvedValue(retry)
        let claimed = false
        mocks.messageUpdateMany.mockImplementation(async ({ where }: any) => {
            if (where.status === 'failed') {
                if (claimed) return { count: 0 }
                claimed = true
                return { count: 1 }
            }
            return { count: 1 }
        })

        const results = await Promise.all([
            MessageService.retrySend('message-1'),
            MessageService.retrySend('message-1'),
        ])

        expect(results).toContainEqual({ success: true, error: undefined })
        expect(results).toContainEqual({ success: false, error: 'Retry already claimed' })
        expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        const claim = mocks.messageUpdateMany.mock.calls
            .map(([input]) => input)
            .find(input => input.where.status === 'failed')
        expect(claim).toMatchObject({
            where: {
                id: 'message-1',
                status: 'failed',
                updatedAt: retry.updatedAt,
            },
            data: {
                status: 'sent',
                sentAt: expect.any(Date),
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    retryLeaseId: expect.any(String),
                    retryStartedAt: expect.any(String),
                }),
            },
        })
    })

    test('fences retry finalization when recovery or another owner has taken the lease', async () => {
        mocks.messageFindUnique.mockResolvedValue(failedMessage('max'))
        mocks.messageUpdateMany
            .mockResolvedValueOnce({ count: 1 })
            .mockResolvedValueOnce({ count: 0 })

        await expect(MessageService.retrySend('message-1')).resolves.toEqual({
            success: false,
            error: 'Retry delivery lease lost',
        })

        expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
        expect(mocks.outboundWorkflow).not.toHaveBeenCalled()
        expect(mocks.recordReachability).not.toHaveBeenCalled()
        expect(mocks.opsLog).toHaveBeenCalledWith(
            'warn',
            'message_retry_lease_lost',
            expect.objectContaining({ messageId: 'message-1', retryAttempt: 1 }),
        )
    })

    test('rejects Message-to-Chat channel drift before claiming or delivering a retry', async () => {
        const retry = failedMessage('telegram')
        retry.channel = 'max'
        mocks.messageFindUnique.mockResolvedValue(retry)

        await expect(MessageService.retrySend('message-1')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_MESSAGE_BINDING_MISMATCH',
        })

        expect(mocks.messageUpdateMany).not.toHaveBeenCalled()
        expect(mocks.telegramSendText).not.toHaveBeenCalled()
        expect(mocks.maxSendText).not.toHaveBeenCalled()
    })

    test('keeps provider delivery successful but logs a returned reachability rejection', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram'))
        mocks.recordReachability.mockResolvedValue({
            outcome: 'rejected',
            reason: 'identity_inactive',
        })

        await expect(MessageService.send('chat-1', 'hello', 'telegram')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })

        expect(mocks.opsLog).toHaveBeenCalledWith(
            'warn',
            'message_reachability_rejected',
            expect.objectContaining({
                operation: 'send',
                chatId: 'chat-1',
                channel: 'telegram',
                reason: 'identity_inactive',
            }),
        )
    })

    test('keeps a retry delivery successful but logs a returned reachability rejection', async () => {
        mocks.messageFindUnique.mockResolvedValue(failedMessage('telegram'))
        mocks.recordReachability.mockResolvedValue({
            outcome: 'rejected',
            reason: 'provider_target_mismatch',
        })

        await expect(MessageService.retrySend('message-1')).resolves.toEqual({
            success: true,
            error: undefined,
        })

        expect(mocks.opsLog).toHaveBeenCalledWith(
            'warn',
            'message_reachability_rejected',
            expect.objectContaining({
                operation: 'retry',
                messageId: 'message-1',
                channel: 'telegram',
                reason: 'provider_target_mismatch',
            }),
        )
    })

    test('uses a live-shaped MAX scraper conversation target without treating providerAccountId as a connection', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            ...chat('max', {
                providerAccountId: 'max-default',
                connectionId: 'max_scraper',
                senderId: 'max-sender-42',
            }),
            externalChatId: 'max-conversation-900',
        })

        await expect(MessageService.send('chat-1', 'hello', 'max')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })

        expect(mocks.maxSendText).toHaveBeenCalledWith({
            target: 'max-conversation-900',
            content: 'hello',
            options: expect.objectContaining({
                providerAccountId: 'max-default',
                isPersonal: true,
                connectionId: undefined,
            }),
        })
        expect(mocks.maxSendText).not.toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ connectionId: 'max-default' }),
        }))
        expect(mocks.maxAssertTransportBinding).toHaveBeenCalledWith({
            providerAccountId: 'max-default',
            connectionId: 'max_scraper',
            isPersonal: true,
        })
        expect(mocks.recordReachability).toHaveBeenCalledWith(expect.objectContaining({
            providerTargetId: 'max-sender-42',
        }))
    })

    test('rejects an unproven MAX account-to-transport mapping before creating a message', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('max', {
            providerAccountId: 'account-b',
            connectionId: 'max_scraper',
            senderId: 'max-sender-42',
        }))
        mocks.maxAssertTransportBinding.mockImplementationOnce(() => {
            throw new Error('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')
        })

        await expect(MessageService.send('chat-1', 'hello', 'max'))
            .rejects.toThrow('CONTACT_CONVERSATION_PROVIDER_TRANSPORT_MISMATCH')

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.maxSendText).not.toHaveBeenCalled()
    })

    test.each([
        ['peer target', {
            status: 'ready' as const,
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'max' as const, externalId: 'different-peer', providerAccountId: 'max-default',
            },
        }],
        ['provider account', {
            status: 'ready' as const,
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'max' as const, externalId: 'max-sender-42', providerAccountId: 'other-account',
            },
        }],
        ['canonical Contact', {
            status: 'ready' as const,
            contact: { id: 'other-contact', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'max' as const, externalId: 'max-sender-42', providerAccountId: 'max-default',
            },
        }],
        ['active identity', { status: 'identity_not_found' as const }],
    ])('rejects a mismatched identity-bound MAX %s before Message mutation', async (_label, prepared) => {
        mocks.chatFindUnique.mockResolvedValue(chat('max', {
            providerAccountId: 'max-default',
            connectionId: 'max_scraper',
            senderId: 'max-sender-42',
        }))
        identityFixtures.set('identity-1', prepared)

        await expect(MessageService.send('chat-1', 'hello', 'max'))
            .rejects.toThrow(/CONTACT_CONVERSATION_IDENTITY_/)

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.maxAssertTransportBinding).not.toHaveBeenCalled()
        expect(mocks.maxSendText).not.toHaveBeenCalled()
    })

    test('rejects a stale identity binding on retry without changing the existing Message', async () => {
        const retry = failedMessage('max')
        retry.chat.metadata = {
            providerAccountId: 'max-default',
            connectionId: 'max_scraper',
            senderId: 'max-sender-42',
            chatKind: 'private',
        }
        mocks.messageFindUnique.mockResolvedValue(retry)
        identityFixtures.set('identity-1', {
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1', channel: 'max', externalId: 'different-peer', providerAccountId: 'max-default',
            },
        })

        await expect(MessageService.retrySend('message-1')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH',
        })

        expect(mocks.messageUpdate).not.toHaveBeenCalled()
        expect(mocks.maxAssertTransportBinding).not.toHaveBeenCalled()
        expect(mocks.maxSendText).not.toHaveBeenCalled()
    })

    test('does not rewrite or merge identity-owned MAX state when delivery reports a different chat id', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            ...chat('max', {
                providerAccountId: 'max-default',
                connectionId: 'max_scraper',
                senderId: 'max-sender-42',
            }),
            externalChatId: 'max-conversation-900',
        })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'delivered',
            externalId: 'max-message-1',
            resolvedChatId: 'max-conversation-901',
        })

        await expect(MessageService.send('chat-1', 'hello', 'max')).resolves.toMatchObject({
            success: true,
            status: 'delivered',
        })

        expect(mocks.chatFindFirst).not.toHaveBeenCalled()
        expect(mocks.messageUpdateMany).not.toHaveBeenCalled()
        expect(mocks.chatUpdate).not.toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({ externalChatId: expect.any(String) }),
        }))
        expect(mocks.chatDelete).not.toHaveBeenCalled()
        expect(mocks.messageUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                status: 'delivered',
                externalId: 'max-message-1',
            }),
        }))
    })

    test('fails a live-shaped Telegram bot chat closed when it has provider ownership but no transport binding', async () => {
        mocks.chatFindUnique.mockResolvedValue(chat('telegram', {
            providerAccountId: 'telegram-default',
        }))

        await expect(MessageService.send('chat-1', 'hello', 'telegram'))
            .rejects.toThrow('CONTACT_CONVERSATION_TRANSPORT_UNBOUND')
        expect(mocks.messageCreate).not.toHaveBeenCalled()

        const retry = failedMessage('telegram')
        retry.chat.metadata = {
            providerAccountId: 'telegram-default',
            chatKind: 'private',
        }
        identityFixtures.set('identity-1', {
            status: 'ready',
            contact: { id: 'contact-1', displayName: 'Contact' },
            identity: {
                id: 'identity-1',
                channel: 'telegram',
                externalId: 'opaque-user-42',
                providerAccountId: 'telegram-default',
            },
        })
        mocks.messageFindUnique.mockResolvedValue(retry)
        await expect(MessageService.retrySend('message-1')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_TRANSPORT_UNBOUND',
        })
        expect(mocks.messageUpdate).not.toHaveBeenCalled()
        expect(mocks.telegramSendText).not.toHaveBeenCalled()
        expect(fetch).not.toHaveBeenCalled()
        expect(mocks.queryRaw).not.toHaveBeenCalled()
    })
})
