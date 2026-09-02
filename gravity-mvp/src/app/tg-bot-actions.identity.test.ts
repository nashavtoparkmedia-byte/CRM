import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    chatFindUnique: vi.fn(),
    botMessageCreate: vi.fn(),
    prepareOutbound: vi.fn(),
    sendBot: vi.fn(),
    requireAdmin: vi.fn(),
    saveManualLink: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: {
        chat: { findUnique: mocks.chatFindUnique },
        botChatMessage: {
            create: mocks.botMessageCreate,
            findMany: vi.fn(),
        },
        driverTelegram: {
            findUnique: vi.fn(),
            upsert: vi.fn(),
        },
    },
}))

vi.mock('@/modules/messaging/public/v1/outbound-conversation-identity-runtime', () => ({
    prepareOutboundConversationV1: mocks.prepareOutbound,
}))

vi.mock('@/modules/telegram-channel/public/v1/bot-message-delivery', () => ({
    sendExactTelegramBotMessageV1: mocks.sendBot,
}))
vi.mock('@/modules/identity-access/public/v1', () => ({
    requireIntegrationAdminAccess: mocks.requireAdmin,
}))
vi.mock('@/modules/telegram-channel/public/v1', () => ({
    saveManualDriverTelegramLinkV1: mocks.saveManualLink,
}))

import { linkTelegramUserToDriver, sendTelegramBotMessage } from './tg-bot-actions'

const exactChat = {
    id: 'chat-exact',
    driverId: 'driver-owned',
    contactId: 'contact-exact',
    contactIdentityId: 'identity-exact',
    channel: 'telegram',
    externalChatId: 'telegram:42',
    chatType: 'private',
    metadata: {
        providerAccountId: 'telegram-account-exact',
        connectionId: 'telegram-connection-exact',
        peerId: '42',
    },
}

const exactBinding = {
    chatId: 'chat-exact',
    channel: 'telegram',
    contactId: 'contact-exact',
    contactIdentityId: 'identity-exact',
    providerAccountId: 'telegram-account-exact',
    connectionId: 'telegram-connection-exact',
    identityTarget: '42',
    target: '42',
    isMaxPersonal: false,
}

describe('sendTelegramBotMessage exact outbound identity boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.chatFindUnique.mockResolvedValue(exactChat)
        mocks.prepareOutbound.mockResolvedValue(exactBinding)
        mocks.sendBot.mockResolvedValue({
            providerAccountId: 'telegram-account-exact',
            connectionId: 'telegram-connection-exact',
            messageId: '1001',
        })
        mocks.botMessageCreate.mockResolvedValue({ id: 'legacy-message-1' })
        mocks.requireAdmin.mockResolvedValue(undefined)
        mocks.saveManualLink.mockResolvedValue({ saved: true })
        vi.spyOn(console, 'log').mockImplementation(() => {})
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    test('preflights the persisted Chat and sends only the prepared peer and connection', async () => {
        const result = await sendTelegramBotMessage('42', 'hello', 'caller-driver')

        expect(result).toEqual({ success: true, messageId: 'legacy-message-1' })
        expect(mocks.chatFindUnique).toHaveBeenCalledWith({
            where: { externalChatId: 'telegram:42' },
            select: {
                id: true,
                driverId: true,
                contactId: true,
                contactIdentityId: true,
                channel: true,
                externalChatId: true,
                chatType: true,
                metadata: true,
            },
        })
        expect(mocks.prepareOutbound).toHaveBeenCalledWith(exactChat)
        expect(mocks.sendBot).toHaveBeenCalledWith({
            peerId: '42',
            text: 'hello',
            providerAccountId: 'telegram-account-exact',
            connectionId: 'telegram-connection-exact',
        })
        expect(mocks.botMessageCreate).toHaveBeenCalledWith({
            data: {
                telegramId: 42n,
                text: 'hello',
                direction: 'OUTGOING',
                driverId: 'driver-owned',
            },
        })
    })

    test('source contains no singleton Bot API or conversation-creation fallback', () => {
        const source = readFileSync(`${process.cwd()}/src/app/tg-bot-actions.ts`, 'utf8')
        expect(source).toContain('prepareOutboundConversationV1(chat)')
        expect(source).toContain('sendExactTelegramBotMessageV1')
        expect(source).not.toMatch(/BOT_API_URL|\bfetch\s*\(|upsertChannelConversationV1/)
    })

    test('fails closed when no already-created conversation exists', async () => {
        mocks.chatFindUnique.mockResolvedValue(null)

        await expect(sendTelegramBotMessage('42', 'hello')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_IDENTITY_REQUIRED',
        })
        expect(mocks.prepareOutbound).not.toHaveBeenCalled()
        expect(mocks.sendBot).not.toHaveBeenCalled()
        expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    })

    test('does not deliver when the exact identity preflight rejects', async () => {
        mocks.prepareOutbound.mockRejectedValue(
            new Error('CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN'),
        )

        await expect(sendTelegramBotMessage('42', 'hello')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_PROVIDER_ACCOUNT_UNPROVEN',
        })
        expect(mocks.sendBot).not.toHaveBeenCalled()
        expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    })

    test('does not trust a prepared binding for a different peer', async () => {
        mocks.prepareOutbound.mockResolvedValue({ ...exactBinding, target: '99' })

        await expect(sendTelegramBotMessage('42', 'hello')).resolves.toEqual({
            success: false,
            error: 'CONTACT_CONVERSATION_IDENTITY_BINDING_MISMATCH',
        })
        expect(mocks.sendBot).not.toHaveBeenCalled()
        expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    })

    test('delivers an inline keyboard through the same exact bot account binding', async () => {
        const inlineKeyboard = [[{ text: 'A', callback_data: 'choice_a' }]]

        await expect(sendTelegramBotMessage('42', 'hello', undefined, inlineKeyboard))
            .resolves.toEqual({ success: true, messageId: 'legacy-message-1' })
        expect(mocks.sendBot).toHaveBeenCalledWith({
            peerId: '42',
            text: 'hello',
            providerAccountId: 'telegram-account-exact',
            connectionId: 'telegram-connection-exact',
            inlineKeyboard,
        })
    })

    test('does not record success when the exact delivery capability rejects', async () => {
        mocks.sendBot.mockRejectedValue(new Error('transport unavailable'))

        await expect(sendTelegramBotMessage('42', 'hello')).resolves.toEqual({
            success: false,
            error: 'transport unavailable',
        })
        expect(mocks.botMessageCreate).not.toHaveBeenCalled()
    })

})

describe('linkTelegramUserToDriver authority boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.requireAdmin.mockResolvedValue(undefined)
        mocks.saveManualLink.mockResolvedValue({ saved: true })
        vi.spyOn(console, 'error').mockImplementation(() => {})
    })

    test('delegates only to the authority-enforcing Telegram owner command', async () => {
        await expect(linkTelegramUserToDriver('42', 'driver-1'))
            .resolves.toEqual({ success: true })
        expect(mocks.requireAdmin).toHaveBeenCalledOnce()
        expect(mocks.saveManualLink).toHaveBeenCalledWith({
            contract: 'telegram_channel.SaveManualDriverTelegramLinkCommand.v1',
            driverId: 'driver-1',
            telegramId: 42n,
        })
    })

    test('performs zero owner mutation when integration-admin auth fails', async () => {
        mocks.requireAdmin.mockRejectedValue(new Error('Forbidden'))

        await expect(linkTelegramUserToDriver('42', 'driver-1'))
            .resolves.toMatchObject({ success: false })
        expect(mocks.saveManualLink).not.toHaveBeenCalled()
    })

    test('contains no direct DriverTelegram upsert or manufactured phone verification', () => {
        const source = readFileSync(`${process.cwd()}/src/app/tg-bot-actions.ts`, 'utf8')
        expect(source).not.toMatch(/driverTelegram\.upsert|phoneVerified\s*:/)
        expect(source).toContain('saveManualDriverTelegramLinkV1')
    })
})
