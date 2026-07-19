import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
    message: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
        create: vi.fn(),
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
        workflowMock.onOutboundMessage.mockResolvedValue(undefined)
    })

    it('reuses the same DB row and records a confirmed MAX retry', async () => {
        maxSendMock.mockResolvedValue({
            externalId: 'd301abcdef01',
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
        })

        const result = await MessageService.retrySend('message-retry-1')

        expect(result.success).toBe(true)
        expect(prismaMock.message.create).not.toHaveBeenCalled()
        expect(prismaMock.message.update).toHaveBeenNthCalledWith(1, {
            where: { id: 'message-retry-1' },
            data: {
                status: 'sent',
                metadata: expect.objectContaining({ retryAttempt: 1 }),
            },
        })
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: 'message-retry-1' },
            data: {
                status: 'delivered',
                externalId: 'd301abcdef01',
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    maxDelivery: expect.objectContaining({
                        operation: 'send',
                        deliveryConfirmed: true,
                        maxMessageId: 'd301abcdef01',
                    }),
                }),
            },
        })
    })

    it('keeps a failed retry on the same row and preserves retryability', async () => {
        maxSendMock.mockRejectedValue(new Error('timeout while waiting for MAX'))

        const result = await MessageService.retrySend('message-retry-1')

        expect(result).toEqual({
            success: false,
            error: 'timeout while waiting for MAX',
        })
        expect(prismaMock.message.create).not.toHaveBeenCalled()
        expect(prismaMock.message.update).toHaveBeenLastCalledWith({
            where: { id: 'message-retry-1' },
            data: {
                status: 'failed',
                externalId: undefined,
                metadata: expect.objectContaining({
                    retryAttempt: 1,
                    retryable: true,
                    error: 'timeout while waiting for MAX',
                }),
            },
        })
    })

    it('respects retry backoff and retry budget without provider calls', async () => {
        prismaMock.message.findUnique.mockResolvedValueOnce(failedMaxMessage({
            metadata: {
                retryable: true,
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
                retryAttempt: 3,
                maxRetries: 3,
                lastFailedAt: new Date(0).toISOString(),
            },
        }))
        expect(await MessageService.retrySend('message-retry-1'))
            .toEqual({ success: false, error: 'Max retries exceeded' })

        expect(maxSendMock).not.toHaveBeenCalled()
    })
})
