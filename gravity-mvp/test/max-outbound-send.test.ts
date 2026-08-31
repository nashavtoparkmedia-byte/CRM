import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    chatUpdate: vi.fn(),
    messageFindUnique: vi.fn(),
    messageFindFirst: vi.fn(),
    messageCreate: vi.fn(),
    messageUpdate: vi.fn(),
    maxSendText: vi.fn(),
    telegramSendText: vi.fn(),
    whatsappSendText: vi.fn(),
    onOutboundMessage: vi.fn(),
    updateReachabilityByChatId: vi.fn(),
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
            findFirst: mocks.messageFindFirst,
            create: mocks.messageCreate,
            update: mocks.messageUpdate,
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
    contactReachabilityV1: { updateReachabilityByChatId: mocks.updateReachabilityByChatId },
}))

vi.mock('@/lib/messageStreamBus', () => ({
    broadcastChatMessage: mocks.broadcastChatMessage,
}))

vi.mock('@/modules/messaging/public/v1/channel-delivery-runtime', () => ({
    getMaxChannelDeliveryV1: () => ({ sendText: mocks.maxSendText }),
    getTelegramChannelDeliveryV1: () => ({ sendText: mocks.telegramSendText }),
    getWhatsAppChannelDeliveryV1: () => ({ sendText: mocks.whatsappSendText }),
}))

import { MessageService } from '../src/lib/MessageService'

function persistedStatusUpdate() {
    return mocks.messageUpdate.mock.calls.find(([input]) => input?.data?.status)?.[0]
}

function persistedStatusUpdates() {
    return mocks.messageUpdate.mock.calls
        .map(([input]) => input)
        .filter(input => input?.data?.status)
}

describe('MessageService MAX outbound delivery', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.messageFindUnique.mockResolvedValue(null)
        mocks.messageFindFirst.mockResolvedValue(null)
        mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
        mocks.messageUpdate.mockResolvedValue({ id: 'message-1' })
        mocks.chatUpdate.mockResolvedValue({ id: 'chat-1' })
        mocks.onOutboundMessage.mockResolvedValue(undefined)
        mocks.updateReachabilityByChatId.mockResolvedValue(undefined)
    })

    it('routes an existing MAX conversation and persists a successful UI delivery without a provider id', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max:902454841098',
            metadata: { uiChatId: '511708938' },
            driver: { id: 'driver-1', fullName: 'Test Driver', phone: '79990000000' },
        })
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
        expect(mocks.updateReachabilityByChatId).toHaveBeenCalledWith('chat-max', 'confirmed')
    })

    it('keeps a validated MAX intermediate result non-delivered', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max:902454841098',
            metadata: {},
            driver: null,
        })
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
        expect(mocks.updateReachabilityByChatId).not.toHaveBeenCalledWith('chat-max', 'confirmed')
    })

    it('persists MAX provider errors as failed and does not advance outbound workflow', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max:902454841098',
            metadata: {},
            driver: null,
        })
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
        expect(mocks.updateReachabilityByChatId).toHaveBeenCalledWith('chat-max', 'unreachable')
    })

    it('keeps neighboring WhatsApp outbound routing unchanged', async () => {
        mocks.chatFindUnique.mockResolvedValue({
            id: 'chat-wa',
            channel: 'whatsapp',
            externalChatId: 'whatsapp:79990000000',
            metadata: { connectionId: 'wa-connection' },
            driver: null,
        })
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
            chatId: '79990000000',
            content: 'Hello WhatsApp',
            quotedMessageId: undefined,
        })
        expect(mocks.maxSendText).not.toHaveBeenCalled()
        expect(persistedStatusUpdate()).toMatchObject({ data: { status: 'delivered' } })
    })

    it('retries a validated MAX UI delivery on the existing Message row', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry MAX',
            clientMessageId: 'cmid-max-retry',
            status: 'failed',
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: {
                id: 'chat-max',
                externalChatId: 'max:902454841098',
                metadata: { uiChatId: '511708938' },
                driver: { fullName: 'Test Driver' },
            },
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

    it('does not mark a retry delivered when MAX-owned validation rejects a contradictory result', async () => {
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry contradiction',
            clientMessageId: 'cmid-max-retry-error',
            status: 'failed',
            metadata: {
                retryable: true,
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: '2020-01-01T00:00:00.000Z',
            },
            chat: {
                id: 'chat-max',
                externalChatId: 'max:902454841098',
                metadata: {},
                driver: null,
            },
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
