import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/prisma', () => ({
    prisma: {
        maxConnection: {
            findUnique: vi.fn(),
            findFirst: vi.fn(),
        },
    },
}))

import { sendMaxPersonalMessage } from '@/app/max-actions'

describe('MAX outbound provider action contract', () => {
    beforeEach(() => {
        vi.restoreAllMocks()
        process.env.MAX_SCRAPER_URL = 'http://max-scraper.fixture'
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('sends repeated equal text as two distinct provider requests', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                externalId: 'd301-out-1',
                chatId: '900001',
                deliveryConfirmed: true,
            }), { status: 200 }))
            .mockResolvedValueOnce(new Response(JSON.stringify({
                success: true,
                externalId: 'd301-out-2',
                chatId: '900001',
                deliveryConfirmed: true,
            }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        const first = await sendMaxPersonalMessage(
            '900001',
            'Одинаковый текст',
            undefined,
            undefined,
            undefined,
            'client-1',
        )
        const second = await sendMaxPersonalMessage(
            '900001',
            'Одинаковый текст',
            undefined,
            undefined,
            undefined,
            'client-2',
        )

        expect(first.externalId).toBe('d301-out-1')
        expect(second.externalId).toBe('d301-out-2')
        expect(fetchMock).toHaveBeenCalledTimes(2)
        expect(fetchMock.mock.calls.map(call => JSON.parse(call[1].body))).toEqual([
            expect.objectContaining({
                message: 'Одинаковый текст',
                clientMessageId: 'client-1',
            }),
            expect.objectContaining({
                message: 'Одинаковый текст',
                clientMessageId: 'client-2',
            }),
        ])
    })

    it('keeps a delayed echo unconfirmed instead of claiming delivery', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            externalId: null,
            chatId: '900001',
            status: 'send_requested',
            deliveryConfirmed: false,
        }), { status: 200 })))

        const result = await sendMaxPersonalMessage('900001', 'Ждём echo')

        expect(result).toMatchObject({
            success: true,
            externalId: null,
            deliveryConfirmed: false,
            deliveryStatus: 'send_requested',
        })
    })

    it('surfaces timeout and failed delivery without converting them to success', async () => {
        const timeout = new Error('aborted')
        timeout.name = 'TimeoutError'
        vi.stubGlobal('fetch', vi.fn().mockRejectedValueOnce(timeout))

        await expect(sendMaxPersonalMessage('900001', 'Таймаут'))
            .rejects.toThrow('MAX send request timed out after 35000ms')

        vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
            error: 'provider rejected fixture',
        }), { status: 422 })))

        await expect(sendMaxPersonalMessage('900001', 'Ошибка'))
            .rejects.toThrow('provider rejected fixture')
    })

    it('keeps reply context structured in one outbound payload', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
            success: true,
            externalId: 'd301-reply-out',
            chatId: '900001',
            deliveryConfirmed: true,
        }), { status: 200 }))
        vi.stubGlobal('fetch', fetchMock)

        await sendMaxPersonalMessage(
            '900001',
            'Ответ',
            undefined,
            'd301-original',
            'web-route-1',
            'client-reply',
            {
                text: 'Исходное сообщение',
                sentAt: '2026-07-18T12:00:00.000Z',
                direction: 'inbound',
            },
        )

        expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
            chatId: '900001',
            message: 'Ответ',
            quotedMsgId: 'd301-original',
            quotedText: 'Исходное сообщение',
            quotedSentAt: '2026-07-18T12:00:00.000Z',
            quotedDirection: 'inbound',
            uiChatId: 'web-route-1',
            clientMessageId: 'client-reply',
        })
    })
})
