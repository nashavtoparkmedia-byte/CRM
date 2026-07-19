import { beforeEach, describe, expect, it, vi } from 'vitest'

const prismaMock = vi.hoisted(() => ({
    message: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
        update: vi.fn(),
    },
    $queryRaw: vi.fn(),
}))
const broadcastMock = vi.hoisted(() => vi.fn())
const waReactMock = vi.hoisted(() => vi.fn())
const tgInvokeMock = vi.hoisted(() => vi.fn())

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/messageStreamBus', () => ({ broadcastChatMessage: broadcastMock }))
vi.mock('@/lib/whatsapp/WhatsAppService', () => ({
    getClient: vi.fn(() => ({
        getChatById: vi.fn(async () => ({
            fetchMessages: vi.fn(async () => [{
                id: { _serialized: 'wa-message-1' },
                react: waReactMock,
            }]),
        })),
    })),
}))
vi.mock('@/app/tg-actions', () => ({
    getClientForReaction: vi.fn(async () => ({ invoke: tgInvokeMock })),
}))
vi.mock('telegram', () => ({
    Api: {
        ReactionEmoji: class ReactionEmoji {
            constructor(public value: unknown) {}
        },
        messages: {
            SendReaction: class SendReaction {
                constructor(public value: unknown) {}
            },
        },
    },
}))

import { POST as sendReaction } from '@/app/api/messages/reaction/route'
import { POST as receiveMaxReaction } from '@/app/api/webhook/max/reaction/route'

function request(url: string, body: Record<string, unknown>) {
    return new Request(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    }) as never
}

function messageFixture(channel: string, externalId: string) {
    return {
        id: `message-${channel}`,
        channel,
        externalId,
        chatId: `chat-${channel}`,
        metadata: {},
        chat: {
            externalChatId: channel === 'telegram'
                ? 'telegram:100500'
                : channel === 'whatsapp'
                    ? '79222155750@c.us'
                    : 'max:900001',
            metadata: { connectionId: `connection-${channel}` },
        },
    }
}

describe('provider reaction route contracts', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.message.update.mockImplementation(async ({ where, data }) => ({
            id: where.id,
            chatId: 'chat-updated',
            metadata: data.metadata,
        }))
    })

    it('sends WhatsApp and Telegram reactions through their provider clients', async () => {
        prismaMock.message.findUnique
            .mockResolvedValueOnce(messageFixture('whatsapp', 'wa-message-1'))
            .mockResolvedValueOnce(messageFixture('telegram', '71'))

        const waResponse = await sendReaction(request(
            'http://localhost/api/messages/reaction',
            { messageId: 'message-whatsapp', emoji: '👍' },
        ))
        const tgResponse = await sendReaction(request(
            'http://localhost/api/messages/reaction',
            { messageId: 'message-telegram', emoji: '❤️' },
        ))

        expect(waResponse.status).toBe(200)
        expect(tgResponse.status).toBe(200)
        expect(waReactMock).toHaveBeenCalledWith('👍')
        expect(tgInvokeMock).toHaveBeenCalledTimes(1)
        expect(prismaMock.message.update).toHaveBeenCalledTimes(2)
    })

    it('keeps MAX outgoing reaction pending until the provider echo arrives', async () => {
        prismaMock.message.findUnique.mockResolvedValue(
            messageFixture('max', 'd301abcdef1234'),
        )
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            reactionConfirmed: false,
        }), { status: 200 })))

        const pending = await sendReaction(request(
            'http://localhost/api/messages/reaction',
            { messageId: 'message-max', emoji: '👍' },
        ))

        expect(pending.status).toBe(202)
        expect(prismaMock.message.update).not.toHaveBeenCalled()

        prismaMock.message.findFirst.mockResolvedValue({
            id: 'message-max',
            chatId: 'chat-max',
            metadata: {},
        })
        const echo = await receiveMaxReaction(request(
            'http://localhost/api/webhook/max/reaction',
            {
                externalMsgId: 'd301abcdef1234',
                emoji: '👍',
                isRemove: false,
            },
        ))

        expect(echo.status).toBe(200)
        expect(prismaMock.message.update).toHaveBeenCalledWith({
            where: { id: 'message-max' },
            data: { metadata: { reactions: { '👍': 1 } } },
        })
        expect(broadcastMock).toHaveBeenCalled()
    })
})
