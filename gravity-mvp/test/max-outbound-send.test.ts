import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        mocks.messageFindMany.mockResolvedValue([])
        mocks.messageFindFirst.mockResolvedValue(null)
        mocks.messageCreate.mockResolvedValue({ id: 'message-1' })
        mocks.messageUpdate.mockResolvedValue({ id: 'message-1' })
        mocks.messageUpdateMany.mockResolvedValue({ count: 0 })
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

    it('retries a real MAX d301 delivery on the existing Message row', async () => {
        const providerId = 'd3010000000000000001'
        mocks.messageFindUnique.mockResolvedValue({
            id: 'message-retry-provider',
            chatId: 'chat-max',
            channel: 'max',
            content: 'Retry MAX provider delivery',
            clientMessageId: 'cmid-max-retry-provider',
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
            metadata: {
                maxDelivery: {
                    operation: 'send',
                    status: 'send_requested',
                    deliveryConfirmed: false,
                    externalId: null,
                },
            },
            chat: {
                id: 'chat-max',
                externalChatId: 'max:902454841098',
                metadata: {},
                driver: null,
            },
        }
        mocks.messageFindMany.mockResolvedValue([{ id: storedMessage.id, metadata: storedMessage.metadata }])
        mocks.messageFindUnique.mockImplementation(async () => storedMessage)
        mocks.messageUpdateMany.mockImplementation(async ({ where, data }) => {
            if (where.id === storedMessage.id) {
                Object.assign(storedMessage, data)
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
        expect(mocks.messageUpdate.mock.calls.every(([input]) => input.where.id === storedMessage.id)).toBe(true)
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
