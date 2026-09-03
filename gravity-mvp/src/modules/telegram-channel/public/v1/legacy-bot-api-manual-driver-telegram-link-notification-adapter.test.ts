import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    authorize: vi.fn(),
    sendExact: vi.fn(),
    findMapping: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
    prisma: { driverTelegram: { findUnique: mocks.findMapping } },
}))
vi.mock('./manual-driver-telegram-link-authority', () => ({
    prepareManualDriverTelegramLinkAuthorityV1: mocks.authorize,
}))
vi.mock('./bot-message-delivery', () => ({
    sendExactTelegramBotMessageV1: mocks.sendExact,
}))

import { legacyBotApiManualDriverTelegramLinkNotificationPortV1 as port } from './legacy-bot-api-manual-driver-telegram-link-notification-adapter'

const authority = {
    chatId: 'chat-42',
    contactId: 'contact-1',
    contactIdentityId: 'identity-42',
    providerAccountId: 'telegram-account-1',
    connectionId: 'telegram-connection-1',
    target: '42',
    identityTarget: '42',
}

describe('manual DriverTelegram notification delivery boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.findMapping.mockResolvedValue({ driverId: 'driver-1' })
        mocks.authorize.mockResolvedValue(authority)
        mocks.sendExact.mockResolvedValue({
            providerAccountId: 'telegram-account-1',
            connectionId: 'telegram-connection-1',
            messageId: 'message-1',
        })
    })

    test('uses only the authority-selected peer, Chat, and connection', async () => {
        await port.notify({ telegramId: 42n, driverName: 'Иван' })

        expect(mocks.findMapping).toHaveBeenCalledWith({
            where: { telegramId: 42n },
            select: { driverId: true },
        })
        expect(mocks.authorize).toHaveBeenCalledWith({ driverId: 'driver-1', telegramId: 42n })
        expect(mocks.sendExact).toHaveBeenCalledWith({
            peerId: '42',
            text: expect.stringContaining('Иван'),
            providerAccountId: 'telegram-account-1',
            connectionId: 'telegram-connection-1',
        })
    })

    test('fails closed without authority and performs no delivery', async () => {
        mocks.authorize.mockRejectedValue(
            new Error('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED'),
        )

        await expect(port.notify({
            telegramId: 42n,
            driverName: 'Иван',
        })).rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
        expect(mocks.sendExact).not.toHaveBeenCalled()
    })

    test('propagates an exact-delivery proof failure', async () => {
        mocks.sendExact.mockRejectedValue(new Error('TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN'))

        await expect(port.notify({
            telegramId: 42n,
            driverName: 'Иван',
        })).rejects.toThrow('TELEGRAM_BOT_DELIVERY_RESULT_UNPROVEN')
    })

    test('performs no delivery when the Telegram peer has no established Driver mapping', async () => {
        mocks.findMapping.mockResolvedValue(null)

        await expect(port.notify({ telegramId: 42n, driverName: 'Иван' }))
            .rejects.toThrow('DRIVER_TELEGRAM_CONFIRMED_MAIN_DRIVER_REQUIRED')
        expect(mocks.authorize).not.toHaveBeenCalled()
        expect(mocks.sendExact).not.toHaveBeenCalled()
    })

    test('contains no raw Bot API peer send', () => {
        const source = readFileSync(
            `${process.cwd()}/src/modules/telegram-channel/public/v1/legacy-bot-api-manual-driver-telegram-link-notification-adapter.ts`,
            'utf8',
        )
        expect(source).not.toMatch(/BOT_API_URL|\bfetch\s*\(/)
        expect(source).toContain('sendExactTelegramBotMessageV1')
    })
})
