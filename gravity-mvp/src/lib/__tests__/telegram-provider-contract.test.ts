import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fixtures from './fixtures/provider-contracts/telegram-events.json'

const prismaMock = vi.hoisted(() => ({
    botChatMessage: { create: vi.fn(), upsert: vi.fn() },
    chat: { upsert: vi.fn(), findUnique: vi.fn() },
    message: { findFirst: vi.fn(), create: vi.fn() },
    contact: { findUnique: vi.fn(), update: vi.fn() },
    contactIdentity: { findUnique: vi.fn(), update: vi.fn() },
    driverTelegram: { findUnique: vi.fn(), update: vi.fn() },
}))

const contactServiceMock = vi.hoisted(() => ({
    resolveContact: vi.fn(),
    ensureChatLinked: vi.fn(),
}))
const workflowMock = vi.hoisted(() => ({
    onInboundMessage: vi.fn(),
    onOutboundMessage: vi.fn(),
    onGroupInboundMessage: vi.fn(),
}))
const sharedContactMock = vi.hoisted(() => ({
    applyTelegramSharedContactPhone: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({ prisma: prismaMock }))
vi.mock('@/lib/ContactService', () => ({ ContactService: contactServiceMock }))
vi.mock('@/lib/DriverMatchService', () => ({
    DriverMatchService: { linkChatToDriver: vi.fn() },
}))
vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: workflowMock,
}))
vi.mock('@/app/tg-bot-actions', () => ({ sendTelegramBotMessage: vi.fn() }))
vi.mock('@/app/actions', () => ({ changeDriverLimit: vi.fn() }))
vi.mock('@/lib/opsLog', () => ({ opsLog: vi.fn() }))
vi.mock('@/lib/telegram-shared-contact', () => sharedContactMock)

import { POST } from '@/app/api/webhook/telegram/route'

function request(event: Record<string, unknown>) {
    return new Request('http://localhost/api/webhook/telegram', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            ...fixtures.privateChat,
            direction: 'INCOMING',
            ...event,
        }),
    }) as never
}

describe('Telegram provider contract fixtures', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        prismaMock.botChatMessage.create.mockResolvedValue({ id: 'legacy-message' })
        prismaMock.botChatMessage.upsert.mockImplementation(async ({ create }) => create)
        prismaMock.chat.upsert.mockResolvedValue({ id: 'chat-tg', driverId: 'driver-1' })
        prismaMock.message.findFirst.mockResolvedValue(null)
        prismaMock.message.create.mockImplementation(async ({ data }) => ({
            id: `message-${prismaMock.message.create.mock.calls.length}`,
            ...data,
        }))
        prismaMock.driverTelegram.findUnique.mockResolvedValue(null)
        contactServiceMock.resolveContact.mockResolvedValue({
            contact: { id: 'contact-1' },
            identity: { id: 'identity-1' },
            isNew: true,
        })
        contactServiceMock.ensureChatLinked.mockResolvedValue(undefined)
        prismaMock.contactIdentity.findUnique.mockResolvedValue({
            displayName: '@driver_fixture',
            metadata: {},
        })
        prismaMock.contactIdentity.update.mockResolvedValue({ id: 'identity-1' })
        sharedContactMock.applyTelegramSharedContactPhone.mockImplementation(
            async ({ senderTelegramUserId, sharedContactUserId }) => ({
                trustResult: senderTelegramUserId === sharedContactUserId
                    ? 'trusted_own_contact'
                    : 'foreign_shared_contact',
            }),
        )
    })

    it('preserves equal inbound text with two different provider IDs', async () => {
        for (const event of fixtures.repeatedInbound) {
            const response = await POST(request(event))
            expect(response.status).toBe(200)
        }

        expect(prismaMock.message.create).toHaveBeenCalledTimes(2)
        expect(prismaMock.message.create.mock.calls.map(call => call[0].data.externalId))
            .toEqual([
                'telegram-bot:100500:71',
                'telegram-bot:100500:72',
            ])
        expect(prismaMock.message.findFirst.mock.calls.map(call => call[0].where))
            .toEqual([
                { externalId: 'telegram-bot:100500:71' },
                { externalId: 'telegram-bot:100500:72' },
            ])
    })

    it('deduplicates a webhook retry by the scoped provider ID', async () => {
        prismaMock.message.findFirst
            .mockResolvedValueOnce(null)
            .mockResolvedValueOnce({ id: 'message-existing' })

        const event = fixtures.repeatedInbound[0]
        await POST(request(event))
        await POST(request(event))

        expect(prismaMock.message.create).toHaveBeenCalledTimes(1)
        expect(prismaMock.botChatMessage.upsert).toHaveBeenCalledTimes(2)
        expect(prismaMock.botChatMessage.upsert.mock.calls[0][0].where)
            .toEqual({ id: 'bot:telegram-bot:100500:71' })
    })

    it('keeps media structured and mirrors outbound direction explicitly', async () => {
        await POST(request(fixtures.media))
        await POST(request({
            providerMessageId: '76',
            text: 'Исходящее зеркало',
            timestamp: '2026-07-18T12:00:05.000Z',
            direction: 'OUTGOING',
        }))

        expect(prismaMock.message.create.mock.calls[0][0].data).toMatchObject({
            type: 'image',
            content: 'Подпись',
            externalId: 'telegram-bot:100500:73',
            metadata: {
                attachments: fixtures.media.attachments,
            },
        })
        expect(prismaMock.message.create.mock.calls[1][0].data).toMatchObject({
            direction: 'outbound',
            externalId: 'telegram-bot:100500:76',
        })
        expect(workflowMock.onOutboundMessage).toHaveBeenCalledTimes(1)
    })

    it('passes own and foreign shared contacts to the strict trust workflow', async () => {
        await POST(request(fixtures.ownSharedContact))
        await POST(request(fixtures.foreignSharedContact))

        expect(sharedContactMock.applyTelegramSharedContactPhone)
            .toHaveBeenNthCalledWith(1, expect.objectContaining({
                senderTelegramUserId: '100500',
                sharedContactUserId: '100500',
                providerMessageId: '74',
                transport: 'bot_webhook',
            }))
        expect(sharedContactMock.applyTelegramSharedContactPhone)
            .toHaveBeenNthCalledWith(2, expect.objectContaining({
                senderTelegramUserId: '100500',
                sharedContactUserId: '200600',
                providerMessageId: '75',
                transport: 'bot_webhook',
            }))
    })

    it('keeps Telegram reply identity in metadata instead of message text', async () => {
        await POST(request(fixtures.reply))

        expect(prismaMock.message.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                content: 'Ответ',
                externalId: 'telegram-bot:100500:77',
                metadata: {
                    quotedMsgId: 'telegram-bot:100500:71',
                },
            }),
        })
        expect(prismaMock.message.create.mock.calls[0][0].data.content)
            .not.toContain('telegram-bot:')
    })

    it('forwards stable Telegram IDs and provider timestamps from tg-bot source', () => {
        const source = readFileSync(
            resolve(process.cwd(), '..', 'tg-bot/src/services/crmIntegration.js'),
            'utf8',
        )

        expect(source).toContain('providerMessageId: providerMessageId')
        expect(source).toContain('replyToProviderMessageId: replyToProviderMessageId')
        expect(source).toContain('ctx.message?.message_id')
        expect(source).toContain('ctx.message.date * 1000')
        expect(source).not.toContain('timestamp: new Date().toISOString()')
    })
})
