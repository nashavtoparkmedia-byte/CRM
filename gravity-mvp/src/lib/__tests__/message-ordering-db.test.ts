import { afterAll, beforeEach, describe, expect, test } from 'vitest'

import { MessageService } from '@/lib/MessageService'
import { prisma } from '@/lib/prisma'

const dbDescribe = process.env.MESSAGE_ORDERING_DB_TEST === '1'
    ? describe
    : describe.skip

dbDescribe('message ordering against isolated PostgreSQL', () => {
    beforeEach(async () => {
        await prisma.$executeRawUnsafe(
            'TRUNCATE TABLE "MessageAttachment", "MessageEventLog", "Message", "Chat" CASCADE',
        )
    })

    afterAll(async () => {
        await prisma.$disconnect()
    })

    test('provider id wins over late database creation time for equal sentAt', async () => {
        const chat = await prisma.chat.create({
            data: {
                id: 'message-ordering-db-chat',
                channel: 'max',
                externalChatId: 'message-ordering-db-external-chat',
            },
        })
        const sentAt = new Date('2026-07-25T10:00:00.000Z')

        await prisma.message.createMany({
            data: [
                {
                    id: 'message-ordering-db-2',
                    chatId: chat.id,
                    channel: 'max',
                    direction: 'inbound',
                    content: '2',
                    externalId: 'd3010000000000000002',
                    sentAt,
                    createdAt: new Date('2026-07-25T10:00:01.000Z'),
                },
                {
                    id: 'message-ordering-db-1',
                    chatId: chat.id,
                    channel: 'max',
                    direction: 'inbound',
                    content: '1',
                    externalId: 'd3010000000000000001',
                    sentAt,
                    createdAt: new Date('2026-07-25T10:00:10.000Z'),
                },
                {
                    id: 'message-ordering-db-3',
                    chatId: chat.id,
                    channel: 'max',
                    direction: 'inbound',
                    content: '3',
                    externalId: 'd3010000000000000003',
                    sentAt,
                    createdAt: new Date('2026-07-25T10:00:02.000Z'),
                },
            ],
        })

        const messages = await MessageService.listMessages(chat.id, 50)

        expect(messages.map((message: { content: string }) => message.content)).toEqual(['1', '2', '3'])
        expect(messages.map((message: { externalId: string | null }) => message.externalId)).toEqual([
            'd3010000000000000001',
            'd3010000000000000002',
            'd3010000000000000003',
        ])
    })
})
