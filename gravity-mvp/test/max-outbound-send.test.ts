import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    messageFindUnique: vi.fn(),
    messageFindMany: vi.fn(),
    messageFindFirst: vi.fn(),
    messageCreate: vi.fn(),
    messageUpdate: vi.fn(),
    messageUpdateMany: vi.fn(),
    maxSendText: vi.fn(),
    maxAssertTransportBinding: vi.fn(),
    telegramSendText: vi.fn(),
    whatsappSendText: vi.fn(),
    onOutboundMessage: vi.fn(),
    prepareIdentity: vi.fn(),
    recordReachability: vi.fn(),
    broadcastChatMessage: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: {
            findUnique: mocks.chatFindUnique,
            update: mocks.chatUpdate,
        },
        message: {
            findUnique: mocks.messageFindUnique,
            findMany: mocks.messageFindMany,
            findFirst: mocks.messageFindFirst,
            create: mocks.messageCreate,
            update: mocks.messageUpdate,
            updateMany: mocks.messageUpdateMany,
        },
    },
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: { onOutboundMessage: mocks.onOutboundMessage },
}))

vi.mock('@/infrastructure/operations/operational-log', () => ({
    operationalLogV1: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/contact-display-policy', () => ({
    buildCanonicalContactSummary: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1/contact-reachability', () => ({
    contactReachabilityV1: { recordExactProviderReachability: mocks.recordReachability },
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    prepareContactConversationIdentityV1: mocks.prepareIdentity,
}))

vi.mock('@/lib/messageStreamBus', () => ({
    broadcastChatMessage: mocks.broadcastChatMessage,
}))

vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({
        assertTransportBinding: mocks.maxAssertTransportBinding,
        sendText: mocks.maxSendText,
    }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.telegramSendText }),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.whatsappSendText }),
}))

import { MessageService } from '../src/lib/MessageService'
import { registerOutboundConversationPreparerV1 } from '../src/modules/messaging/public/v1/outbound-conversation-identity-runtime'
import { prepareOutboundConversationV1 as preparePlatformOutboundConversationV1 } from '../src/modules/platform-shell/public/v1/outbound-conversation-identity'

type Channel = 'max' | 'whatsapp'
type IdentityFixture = {
    status: 'ready' | 'identity_not_found'
    contact?: { id: string; displayName: string }
    identity?: {
        id: string
        channel: Channel
        externalId: string
        providerAccountId: string | null
    }
}

const identityFixtures = new Map<string, IdentityFixture>()

function boundChat(
    channel: Channel,
    overrides: Record<string, any> = {},
) {
    const defaultMetadata = channel === 'max'
        ? {
            providerAccountId: 'max-provider-account',
            connectionId: 'scraper',
            senderId: 'max-peer-42',
            chatKind: 'private',
        }
        : {
            providerAccountId: 'wa-connection',
            connectionId: 'wa-connection',
        }
    const metadata = { ...defaultMetadata, ...(overrides.metadata ?? {}) }
    const result = {
        id: channel === 'max' ? 'chat-max' : 'chat-wa',
        channel,
        externalChatId: channel === 'max' ? 'max:902454841098' : 'whatsapp:79990000000',
        chatType: channel === 'max' ? 'private' : null,
        contactId: 'contact-1',
        contactIdentityId: 'identity-1',
        driver: null,
        ...overrides,
        metadata,
    }
    identityFixtures.set(result.contactIdentityId, {
        status: 'ready',
        contact: { id: result.contactId, displayName: 'Contact' },
        identity: {
            id: result.contactIdentityId,
            channel,
            externalId: channel === 'max' ? metadata.senderId : '79990000000@c.us',
            providerAccountId: metadata.providerAccountId,
        },
    })
    return result
}

function persistedStatusUpdate() {
    return mocks.messageUpdate.mock.calls.find(([input]) => input?.data?.status)?.[0]
}

function persistedStatusUpdates() {
    return mocks.messageUpdateMany.mock.calls
        .map(([input]) => input)
        .filter(input => input?.data?.status)
}

describe('MessageService MAX outbound delivery', () => {
    let unregisterOutboundPreparer: (() => void) | undefined

    beforeEach(() => {
        vi.clearAllMocks()
        identityFixtures.clear()
        mocks.prepareIdentity.mockImplementation(async ({ identityId }: { identityId: string }) => (
            identityFixtures.get(identityId) ?? { status: 'identity_not_found' }
        ))
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.messageFindMany.mockResolvedValue([])
        mocks.messageFindFirst.mockResolvedValue(null)
        mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
        mocks.messageUpdate.mockResolvedValue({ id: 'message-1' })
        mocks.messageUpdateMany.mockResolvedValue({ count: 1 })
        mocks.chatUpdate.mockResolvedValue({ id: 'chat-1' })
        mocks.onOutboundMessage.mockResolvedValue(undefined)
        mocks.recordReachability.mockResolvedValue({
            outcome: 'updated',
            identityId: 'identity-1',
            status: 'confirmed',
        })
        unregisterOutboundPreparer = registerOutboundConversationPreparerV1(
            preparePlatformOutboundConversationV1,
        )
    })

    afterEach(() => {
        unregisterOutboundPreparer?.()
    })

    it('routes an existing MAX conversation and persists a successful UI delivery without a provider id', async () => {
        mocks.chatFindUnique.mockResolvedValue(boundChat('max', {
            metadata: { uiChatId: '511708938' },
            driver: { id: 'driver-1', fullName: 'Test Driver', phone: '79990000000' },
        }))
        mocks.maxSendText.mockResolvedValue({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: null,
        })

        const result = await MessageService.send(
            'chat-max',
            'Hello MAX',
            'max',
            undefined,
            'cmid-max-1',
        )

        expect(result).toMatchObject({
            success: true,
            chatId: 'chat-max',
            id: expect.stringMatching(/^msg_/),
            status: 'delivered',
            externalId: null,
            deliveryConfirmed: true,
        })

        expect(mocks.maxSendText).toHaveBeenCalledWith({
            target: '902454841098',
            content: 'Hello MAX',
            options: expect.objectContaining({
                isPersonal: true,
                name: 'Test Driver',
                uiChatId: '511708938',
                clientMessageId: 'cmid-max-1',
            }),
        })
        expect(mocks.telegramSendText).not.toHaveBeenCalled()
        expect(mocks.whatsappSendText).not.toHaveBeenCalled()
        expect(persistedStatusUpdate()).toMatchObject({
            where: { id: result.id },
            data: {
                status: 'delivered',
                metadata: {
                    maxDelivery: expect.objectContaining({
                        status: 'delivered',
                        deliveryConfirmed: true,
                        maxMessageId: null,
                        protocolChatId: '902454841098',
                        webRouteId: '511708938',
                    }),
                },
            },
        })
        expect(mocks.onOutboundMessage).toHaveBeenCalledWith('chat-max', expect.any(Date))
        expect(mocks.recordReachability).toHaveBeenCalledWith({
            identityId: 'identity-1',
            contactId: 'contact-1',
            channel: 'max',
            providerAccountId: 'max-provider-account',
            providerTargetId: 'max-peer-42',
            status: 'confirmed',
        })
    })

    it('keeps a validated MAX intermediate result non-delivered', async () => {
        mocks.chatFindUnique.mockResolvedValue(boundChat('max'))
        mocks.maxSendText.mockResolvedValue({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: null,
        })

        await expect(MessageService.send(
            'chat-max',
            'Pending MAX',
            'max',
            undefined,
            'cmid-max-pending',
        )).resolves.toMatchObject({
            success: true,
            status: 'sent',
            externalId: null,
            deliveryConfirmed: false,
        })

        expect(persistedStatusUpdate()).toMatchObject({
            data: {
                status: 'sent',
                metadata: {
                    maxDelivery: expect.objectContaining({
                        status: 'send_requested',
                        deliveryConfirmed: false,
                    }),
                },
            },
        })
        expect(mocks.recordReachability).not.toHaveBeenCalled()
    })

    it('persists MAX provider errors as failed and does not advance outbound workflow', async () => {
        mocks.chatFindUnique.mockResolvedValue(boundChat('max'))
        mocks.maxSendText.mockRejectedValue(new Error('ECONNREFUSED MAX scraper'))

        await expect(MessageService.send(
            'chat-max',
            'Failure case',
            'max',
            undefined,
            'cmid-max-error',
        )).resolves.toMatchObject({
            success: false,
            status: 'failed',
            error: 'ECONNREFUSED MAX scraper',
        })

        expect(persistedStatusUpdate()).toMatchObject({
            data: {
                status: 'failed',
                metadata: expect.objectContaining({
                    error: 'ECONNREFUSED MAX scraper',
                    errorCode: 'NETWORK_ERROR',
                    retryable: true,
                }),
            },
        })
        expect(mocks.onOutboundMessage).not.toHaveBeenCalled()
        expect(mocks.recordReachability).not.toHaveBeenCalled()
    })

    it('keeps neighboring WhatsApp outbound routing unchanged', async () => {
        mocks.chatFindUnique.mockResolvedValue(boundChat('whatsapp'))
        mocks.whatsappSendText.mockResolvedValue({ externalId: 'wa-message-1' })

        await expect(MessageService.send(
            'chat-wa',
            'Hello WhatsApp',
            'whatsapp',
            undefined,
            'cmid-wa-1',
        )).resolves.toMatchObject({ success: true, status: 'delivered' })

        expect(mocks.whatsappSendText).toHaveBeenCalledWith({
            connectionId: 'wa-connection',
            chatId: '79990000000@c.us',
            content: 'Hello WhatsApp',
            quotedMessageId: undefined,
        })
        expect(mocks.maxSendText).not.toHaveBeenCalled()
        expect(persistedStatusUpdate()).toMatchObject({ data: { status: 'delivered' } })
    })

    it('rejects a MAX send when the persisted ContactIdentity binding is absent', async () => {
        const unbound = { ...boundChat('max'), contactIdentityId: null }
        mocks.chatFindUnique.mockResolvedValue(unbound)

        await expect(MessageService.send('chat-max', 'Unbound MAX', 'max'))
            .rejects.toThrow('CONTACT_CONVERSATION_IDENTITY_REQUIRED')

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.maxSendText).not.toHaveBeenCalled()
    })

    it('retries a validated MAX UI delivery on the existing Message row', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry MAX',
            clientMessageId: 'cmid-max-retry',
            status: 'failed',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: boundChat('max', {
                metadata: { uiChatId: '511708938' },
                driver: { fullName: 'Test Driver' },
            }),
        })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'delivered',
            externalId: null,
            resolvedChatId: null,
        })

        await expect(MessageService.retrySend('message-retry')).resolves.toEqual({ success: true })

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(persistedStatusUpdates()).toHaveLength(2)
        expect(persistedStatusUpdates()[0]).toMatchObject({
            where: { id: 'message-retry' },
            data: { status: 'sent' },
        })
        expect(persistedStatusUpdates()[1]).toMatchObject({
            where: { id: 'message-retry' },
            data: {
                status: 'delivered',
                metadata: expect.objectContaining({
                    maxDelivery: expect.objectContaining({
                        status: 'delivered',
                        deliveryConfirmed: true,
                        externalId: null,
                    }),
                }),
            },
        })
        expect(mocks.onOutboundMessage).toHaveBeenCalledWith('chat-max', expect.any(Date))
    })

    it('retries a real MAX d301 delivery on the existing Message row', async () => {
        const providerId = 'd3010000000000000001'
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry-provider',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry MAX provider delivery',
            clientMessageId: 'cmid-max-retry-provider',
            status: 'failed',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: boundChat('max'),
        })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'delivered',
            externalId: providerId,
            resolvedChatId: null,
        })

        await expect(MessageService.retrySend('message-retry-provider')).resolves.toEqual({ success: true })

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(persistedStatusUpdates().at(-1)).toMatchObject({
            where: { id: 'message-retry-provider' },
            data: {
                status: 'delivered',
                externalId: providerId,
                metadata: expect.objectContaining({
                    maxDelivery: expect.objectContaining({
                        status: 'delivered',
                        maxMessageId: providerId,
                        externalId: providerId,
                    }),
                }),
            },
        })
    })

    it('keeps a MAX pending/intermediate retry on the existing Message row', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry-pending',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry MAX pending',
            clientMessageId: 'cmid-max-retry-pending',
            status: 'failed',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: boundChat('max'),
        })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: null,
        })

        await expect(MessageService.retrySend('message-retry-pending')).resolves.toEqual({ success: true })

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(persistedStatusUpdates().at(-1)).toMatchObject({
            where: { id: 'message-retry-pending' },
            data: {
                status: 'sent',
                metadata: expect.objectContaining({
                    maxDelivery: expect.objectContaining({
                        status: 'send_requested',
                        deliveryConfirmed: false,
                        externalId: null,
                    }),
                }),
            },
        })
    })

    it('keeps pending MAX delivery retryable through recovery and reuses the same Message row', async () => {
        const storedMessage: any = {
            id: 'message-recovery-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Recover then retry MAX',
            clientMessageId: 'cmid-max-recovery-retry',
            direction: 'outbound',
            status: 'sent',
            externalId: null,
            type: 'text',
            sentAt: new Date('2020-01-01T00:00:00.000Z'),
            updatedAt: new Date('2020-01-01T00:00:00.000Z'),
            metadata: {
                maxDelivery: {
                    operation: 'send',
                    status: 'send_requested',
                    deliveryConfirmed: false,
                    externalId: null,
                },
            },
            chat: boundChat('max'),
        }
        mocks.messageFindMany.mockResolvedValue([{ id: storedMessage.id, metadata: storedMessage.metadata }])
        mocks.messageFindUnique.mockImplementation(async () => storedMessage)
        mocks.messageUpdateMany.mockImplementation(async ({ where, data }) => {
            if (where.id === storedMessage.id) {
                Object.assign(storedMessage, data)
                storedMessage.updatedAt = new Date()
                return { count: 1 }
            }
            return { count: 0 }
        })
        mocks.messageUpdate.mockImplementation(async ({ data }) => {
            Object.assign(storedMessage, data)
            return storedMessage
        })
        mocks.maxSendText.mockResolvedValue({
            outcome: 'pending',
            externalId: null,
            resolvedChatId: null,
        })

        await expect(MessageService.recoverStuckMessages(5)).resolves.toBe(1)
        expect(storedMessage).toMatchObject({
            id: 'message-recovery-retry',
            status: 'failed',
            metadata: {
                maxDelivery: expect.objectContaining({ status: 'send_requested' }),
                errorCode: 'TIMEOUT',
                retryable: true,
            },
        })

        await expect(MessageService.retrySend(storedMessage.id)).resolves.toEqual({ success: true })

        expect(storedMessage).toMatchObject({
            id: 'message-recovery-retry',
            status: 'sent',
            metadata: {
                maxDelivery: expect.objectContaining({
                    status: 'send_requested',
                    deliveryConfirmed: false,
                }),
                retryable: true,
                retryAttempt: 1,
            },
        })
        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(mocks.messageUpdate).not.toHaveBeenCalled()
    })

    it('refreshes the retry lease timestamp so recovery cannot reclaim an active provider attempt', async () => {
        const storedMessage: any = {
            id: 'message-active-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Active retry MAX',
            clientMessageId: 'cmid-max-active-retry',
            direction: 'outbound',
            status: 'failed',
            externalId: null,
            type: 'text',
            sentAt: new Date('2020-01-01T00:00:00.000Z'),
            updatedAt: new Date('2020-01-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: boundChat('max'),
        }
        mocks.messageFindUnique.mockResolvedValue(storedMessage)
        mocks.messageFindMany.mockImplementation(async () => (
            storedMessage.status === 'sent'
            && storedMessage.sentAt.getTime() < Date.now() - 5 * 60_000
                ? [{ id: storedMessage.id, metadata: storedMessage.metadata }]
                : []
        ))
        mocks.messageUpdateMany.mockImplementation(async ({ where, data }) => {
            if (where.OR) return { count: 0 }
            if (where.id !== storedMessage.id) return { count: 0 }
            if (where.status && storedMessage.status !== where.status) return { count: 0 }
            if (where.sentAt?.lt && storedMessage.sentAt >= where.sentAt.lt) return { count: 0 }
            Object.assign(storedMessage, data)
            storedMessage.updatedAt = new Date()
            return { count: 1 }
        })
        let releaseProvider!: () => void
        let providerStarted!: () => void
        const providerStart = new Promise<void>(resolve => { providerStarted = resolve })
        const providerRelease = new Promise<void>(resolve => { releaseProvider = resolve })
        mocks.maxSendText.mockImplementation(async () => {
            providerStarted()
            await providerRelease
            return { outcome: 'pending', externalId: null, resolvedChatId: null }
        })

        const retry = MessageService.retrySend(storedMessage.id)
        await providerStart
        const leasedSentAt = storedMessage.sentAt

        await expect(MessageService.recoverStuckMessages(5)).resolves.toBe(0)
        expect(storedMessage.status).toBe('sent')
        expect(leasedSentAt.getTime()).toBeGreaterThan(Date.now() - 5 * 60_000)

        releaseProvider()
        await expect(retry).resolves.toEqual({ success: true })
        expect(mocks.maxSendText).toHaveBeenCalledTimes(1)
    })

    it('does not mark a retry delivered when MAX-owned validation rejects a contradictory result', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry contradiction',
            clientMessageId: 'cmid-max-retry-error',
            status: 'failed',
            updatedAt: new Date('2026-09-01T00:00:00.000Z'),
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: boundChat('max'),
        })
        mocks.maxSendText.mockRejectedValue(new Error('MAX delivery result is contradictory'))

        await expect(MessageService.retrySend('message-retry')).resolves.toEqual({
            success: false,
            error: 'MAX delivery result is contradictory',
        })

        expect(mocks.messageCreate).not.toHaveBeenCalled()
        expect(persistedStatusUpdates().at(-1)).toMatchObject({
            where: { id: 'message-retry' },
            data: {
                status: 'failed',
                metadata: expect.objectContaining({
                    error: 'MAX delivery result is contradictory',
                }),
            },
        })
        expect(mocks.onOutboundMessage).not.toHaveBeenCalled()
    })
})
