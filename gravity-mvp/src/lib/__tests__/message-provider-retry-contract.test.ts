import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
    message: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
    },
    chat: {
        findUnique: vi.fn(),
        update: vi.fn(),
    },
    whatsAppConnection: { findFirst: vi.fn() },
    $queryRaw: vi.fn(),
}))
const maxSendMock = vi.hoisted(() => vi.fn())
const workflowMock = vi.hoisted(() => ({ onOutboundMessage: vi.fn() }))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/whatsapp/WhatsAppService', () => ({ sendMessage: vi.fn() }))
vi.mock('@/app/max-actions', () => ({ sendMaxMessage: maxSendMock }))
vi.mock('@/app/settings/integrations/whatsapp/whatsapp-actions', () => ({
    sendWhatsAppMessage: vi.fn(),
}))
vi.mock('@/app/tg-actions', () => ({ sendTelegramMessage: vi.fn() }))
vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: workflowMock,
}))
vi.mock('@/lib/opsLog', () => ({ opsLog: vi.fn() }))
vi.mock('@/lib/ReachabilityService', () => ({ updateReachabilityByChatId: vi.fn() }))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: vi.fn() }))

import { MessageService } from '@/lib/MessageService'

function failedMaxMessage(overrides: Record<string, unknown> = {}) {
    return {
        id: 'message-retry-1',
        clientMessageId: 'client-retry-1',
        chatId: 'chat-max',
        channel: 'max',
        content: 'Повторить меня',
        status: 'failed',
        metadata: {
            retryable: true,
            maxDelivery: { status: 'retryable_failed', deliveryConfirmed: false },
            retryAttempt: 0,
            maxRetries: 3,
            lastFailedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
        },
        chat: {
            id: 'chat-max',
            externalChatId: 'max:900001',
            metadata: {},
            driver: { fullName: 'Fixture Driver' },
        },
        ...overrides,
    }
}

describe('MessageService provider retry contract', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.message.findUnique.mockResolvedValue(failedMaxMessage())
        prismaMock.message.findFirst.mockResolvedValue(null)
        prismaMock.message.update.mockResolvedValue({ id: 'message-retry-1' })
        prismaMock.chat.update.mockResolvedValue({ id: 'chat-max' })
        workflowMock.onOutboundMessage.mockResolvedValue(undefined)
    })

    it('reuses the same DB row and records a confirmed MAX retry', async () => {
        maxSendMock.mockResolvedValue({
            externalId: 'd301abcdef01234567',
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        })

        const result = await MessageService.retrySend('message-retry-1')

        expect(result.success).toBe(true)
        expect(prismaMock.message.create).not.toHaveBeenCalled()
        expect(prismaMock.message.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'message-retry-1' },
            data: {
                status: 'queued',
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    maxDelivery: expect.objectContaining({
                        status: 'queued',
                        deliveryConfirmed: false,
                    }),
                }),
            },
        })
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: 'message-retry-1' },
            data: {
                status: 'delivered',
                externalId: 'd301abcdef01234567',
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    maxDelivery: expect.objectContaining({
                        operation: 'send',
                        status: 'provider_confirmed',
                        deliveryConfirmed: true,
                        maxMessageId: 'd301abcdef01234567',
                    }),
                }),
            },
        })
    })

    it('keeps MAX durable pre-action route refusal failed and retryable on the same row', async () => {
        maxSendMock.mockRejectedValue(new Error('Durable fenced text route is required'))

        const result = await MessageService.retrySend('message-retry-1')

        expect(result).toEqual({
            success: false,
            error: 'Durable fenced text route is required',
        })
        expect(prismaMock.message.create).not.toHaveBeenCalled()
        expect(workflowMock.onOutboundMessage).not.toHaveBeenCalled()
        expect(prismaMock.message.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'message-retry-1' },
            data: {
                status: 'queued',
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    maxDelivery: expect.objectContaining({
                        status: 'queued',
                        deliveryConfirmed: false,
                    }),
                }),
            },
        })
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: 'message-retry-1' },
            data: {
                status: 'failed',
                externalId: undefined,
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    retryable: true,
                    error: 'Durable fenced text route is required',
                    maxDelivery: expect.objectContaining({
                        status: 'retryable_failed',
                        deliveryConfirmed: false,
                        failurePhase: 'before_provider_action',
                        safeErrorCode: 'DURABLE_TEXT_ROUTE_REQUIRED',
                    }),
                }),
            },
        })
    })

    it('turns a lost retry response into needs_review on the same row without blind retry', async () => {
        maxSendMock.mockRejectedValue(new Error('timeout while waiting for MAX'))

        const result = await MessageService.retrySend('message-retry-1')

        expect(result).toEqual({
            success: true,
            error: 'timeout while waiting for MAX',
        })
        expect(prismaMock.message.create).not.toHaveBeenCalled()
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: 'message-retry-1' },
            data: {
                status: 'sent',
                externalId: undefined,
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    retryable: false,
                    error: 'timeout while waiting for MAX',
                    maxDelivery: expect.objectContaining({
                        status: 'needs_review',
                        deliveryConfirmed: false,
                    }),
                }),
            },
        })
    })

    it('turns a lost initial MAX response into needs_review instead of hard failure', async () => {
        prismaMock.chat.findUnique.mockResolvedValue({
            id: 'chat-max',
            channel: 'max',
            externalChatId: 'max:900001',
            metadata: {},
            driver: { id: 'driver-1', fullName: 'Fixture Driver', phone: null },
        })
        prismaMock.message.findUnique.mockResolvedValueOnce(null)
        prismaMock.message.create.mockResolvedValue({ id: 'message-initial-1' })
        maxSendMock.mockRejectedValueOnce(new Error('gateway response lost'))

        const result = await MessageService.send(
            'chat-max', 'Initial uncertain send', 'max', undefined, 'client-initial-1',
        )

        expect(result).toMatchObject({
            success: true,
            status: 'sent',
            metadata: { maxDelivery: { status: 'needs_review', deliveryConfirmed: false } },
            error: 'gateway response lost',
        })
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: expect.any(String) },
            data: expect.objectContaining({
                status: 'sent',
                metadata: expect.objectContaining({
                    retryable: false,
                    maxDelivery: expect.objectContaining({ status: 'needs_review' }),
                }),
            }),
        })
    })

    it('respects retry backoff and retry budget without provider calls', async () => {
        prismaMock.message.findUnique.mockResolvedValueOnce(failedMaxMessage({
            metadata: {
                retryable: true,
                maxDelivery: { status: 'retryable_failed', deliveryConfirmed: false },
                retryAttempt: 0,
                maxRetries: 3,
                lastFailedAt: new Date().toISOString(),
            },
        }))
        expect(await MessageService.retrySend('message-retry-1'))
            .toEqual({ success: false, error: 'Backoff not elapsed' })

        prismaMock.message.findUnique.mockResolvedValueOnce(failedMaxMessage({
            metadata: {
                retryable: true,
                maxDelivery: { status: 'retryable_failed', deliveryConfirmed: false },
                retryAttempt: 3,
                maxRetries: 3,
                lastFailedAt: new Date(0).toISOString(),
            },
        }))
        expect(await MessageService.retrySend('message-retry-1'))
            .toEqual({ success: false, error: 'Max retries exceeded' })

        expect(maxSendMock).not.toHaveBeenCalled()
    })

    it('blocks manual retry for an unknown physical outcome even if legacy metadata says retryable', async () => {
        prismaMock.message.findUnique.mockResolvedValueOnce(failedMaxMessage({
            metadata: {
                retryable: true,
                maxDelivery: { status: 'needs_review', deliveryConfirmed: false },
            },
        }))

        expect(await MessageService.retrySend('message-retry-1')).toEqual({
            success: false,
            error: 'Personal MAX reconciliation or exact pre-action proof is required',
        })
        expect(maxSendMock).not.toHaveBeenCalled()
        expect(prismaMock.message.update).not.toHaveBeenCalled()
    })
})
