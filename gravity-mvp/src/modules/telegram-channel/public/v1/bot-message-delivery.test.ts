import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import { sendExactTelegramBotMessageV1 } from './bot-message-delivery'

describe('exact Telegram Bot API delivery boundary', () => {
    beforeEach(() => {
        vi.stubEnv('BOT_API_URL', 'http://telegram-bot.internal:3001/api/bot')
        vi.stubEnv('BOT_CRM_SECRET', 'shared-secret')
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.unstubAllGlobals()
    })

    test('passes exact account, connection, peer and keyboard and verifies echoed live proof', async () => {
        const providerFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                success: true,
                providerAccountId: 'bot-123',
                connectionId: 'bot-connection',
                messageId: '9001',
            }),
        })
        vi.stubGlobal('fetch', providerFetch)
        const inlineKeyboard = [[{ text: 'Choose', callback_data: 'choose' }]]

        await expect(sendExactTelegramBotMessageV1({
            providerAccountId: 'bot-123',
            connectionId: 'bot-connection',
            peerId: '42',
            text: 'hello',
            inlineKeyboard,
        })).resolves.toEqual({
            providerAccountId: 'bot-123',
            connectionId: 'bot-connection',
            messageId: '9001',
        })
        expect(providerFetch).toHaveBeenCalledWith(
            'http://telegram-bot.internal:3001/api/bot/send-message',
            expect.objectContaining({
                headers: {
                    'Content-Type': 'application/json',
                    'x-bot-signature': 'shared-secret',
                },
                body: JSON.stringify({
                    chatId: '42',
                    text: 'hello',
                    providerAccountId: 'bot-123',
                    connectionId: 'bot-connection',
                    inlineKeyboard,
                }),
            }),
        )
    })

    test.each([
        [{ providerAccountId: 'bot-123', connectionId: 'bot-connection', peerId: 'not-a-peer', text: 'hello' }, 'TELEGRAM_OUTBOUND_PEER_INVALID'],
        [{ providerAccountId: 'legacy', connectionId: 'bot-connection', peerId: '42', text: 'hello' }, 'TELEGRAM_BOT_PROVIDER_ACCOUNT_UNPROVEN'],
        [{ providerAccountId: 'bot-123', connectionId: '', peerId: '42', text: 'hello' }, 'TELEGRAM_BOT_CONNECTION_UNPROVEN'],
    ])('rejects an unproven binding before fetch', async (input, error) => {
        const providerFetch = vi.fn()
        vi.stubGlobal('fetch', providerFetch)
        await expect(sendExactTelegramBotMessageV1(input)).rejects.toThrow(error)
        expect(providerFetch).not.toHaveBeenCalled()
    })

    test('rejects account or connection proof mismatches after the bot responds', async () => {
        const providerFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                success: true,
                providerAccountId: 'other-bot',
                connectionId: 'bot-connection',
                messageId: '9001',
            }),
        })
        vi.stubGlobal('fetch', providerFetch)
        await expect(sendExactTelegramBotMessageV1({
            providerAccountId: 'bot-123',
            connectionId: 'bot-connection',
            peerId: '42',
            text: 'hello',
        })).rejects.toThrow('TELEGRAM_BOT_PROVIDER_ACCOUNT_PROOF_MISMATCH')
    })

    test('fails closed before fetch when transport configuration is absent', async () => {
        vi.stubEnv('BOT_API_URL', '')
        vi.stubEnv('TG_BOT_API_URL', '')
        const providerFetch = vi.fn()
        vi.stubGlobal('fetch', providerFetch)
        await expect(sendExactTelegramBotMessageV1({
            providerAccountId: 'bot-123',
            connectionId: 'bot-connection',
            peerId: '42',
            text: 'hello',
        })).rejects.toThrow('TELEGRAM_BOT_TRANSPORT_URL_UNPROVEN')
        expect(providerFetch).not.toHaveBeenCalled()
    })
})
