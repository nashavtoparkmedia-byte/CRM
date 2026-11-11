import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

import {
    readTelegramBotTokenV1,
    sendExactTelegramBotMessageV1,
    telegramBotCrmSecretV1,
    verifyTelegramBotCrmSignatureV1,
} from './bot-message-delivery'

describe('exact Telegram Bot API delivery boundary', () => {
    beforeEach(() => {
        vi.stubEnv('BOT_API_URL', 'http://telegram-bot.internal:3001/api/bot')
        vi.stubEnv('BOT_CRM_SECRET', 'test-bot-crm-shared-secret-0123456789abcdef')
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
                    'x-bot-signature': 'test-bot-crm-shared-secret-0123456789abcdef',
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
        [{ providerAccountId: 'bot-123', connectionId: '', peerId: '42', text: 'hello' }, 'TELEGRAM_BOT_CONNECTION_UNPROVEN'],
    ])('rejects an unproven binding before fetch', async (input, error) => {
        const providerFetch = vi.fn()
        vi.stubGlobal('fetch', providerFetch)
        await expect(sendExactTelegramBotMessageV1(input)).rejects.toThrow(error)
        expect(providerFetch).not.toHaveBeenCalled()
    })

    test('sends without a provider account and skips only that echo proof', async () => {
        const providerFetch = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                success: true,
                connectionId: 'bot-connection',
                messageId: '9001',
            }),
        })
        vi.stubGlobal('fetch', providerFetch)

        // No production Telegram conversation carries a provider-account stamp.
        // Demanding one rejected every bot send while proving nothing; the
        // connection proof below is unaffected.
        await expect(sendExactTelegramBotMessageV1({
            providerAccountId: null, connectionId: 'bot-connection', peerId: '42', text: 'hello',
        })).resolves.toBeTruthy()
        expect(providerFetch).toHaveBeenCalledOnce()
        const body = JSON.parse(vi.mocked(providerFetch).mock.calls[0][1].body)
        expect(body).not.toHaveProperty('providerAccountId')
        expect(body.connectionId).toBe('bot-connection')
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

const STRONG = 'bot-crm-test-secret-Z9y8X7w6V5u4T3s2R1q0'

describe('the CRM<->bot shared secret (T3-1)', () => {
    test('only a strong secret is accepted; there is no fallback value', () => {
        for (const value of [undefined, '', ' ', 'secret', 'x'.repeat(31), ` ${STRONG}`, `${STRONG}\n`, 'x'.repeat(257), 'replace-me-with-a-generated-value-0123456789', 'placeholder-placeholder-placeholder-00']) {
            expect(telegramBotCrmSecretV1({ BOT_CRM_SECRET: value })).toBeNull()
        }
        expect(telegramBotCrmSecretV1({})).toBeNull()
        expect(telegramBotCrmSecretV1({ BOT_CRM_SECRET: STRONG })).toBe(STRONG)
    })

    test('a signature matches only the exact strong secret', () => {
        const environment = { BOT_CRM_SECRET: STRONG }
        expect(verifyTelegramBotCrmSignatureV1(STRONG, environment)).toBe(true)
        expect(verifyTelegramBotCrmSignatureV1(`${STRONG}x`, environment)).toBe(false)
        expect(verifyTelegramBotCrmSignatureV1(STRONG.slice(0, -1), environment)).toBe(false)
        expect(verifyTelegramBotCrmSignatureV1('', environment)).toBe(false)
        expect(verifyTelegramBotCrmSignatureV1(null, environment)).toBe(false)
        // An empty or weak configured secret matches nothing, not even an equal header.
        expect(verifyTelegramBotCrmSignatureV1('', { BOT_CRM_SECRET: '' })).toBe(false)
        expect(verifyTelegramBotCrmSignatureV1('short', { BOT_CRM_SECRET: 'short' })).toBe(false)
        expect(verifyTelegramBotCrmSignatureV1(undefined, {})).toBe(false)
    })

    test('the comparison is constant-time over digests, never a string equality', () => {
        const source = readFileSync(join(__dirname, 'bot-message-delivery.ts'), 'utf8')
        const body = source.split('export function verifyTelegramBotCrmSignatureV1', 2)[1].split('\n}\n', 1)[0]
        expect(body).toMatch(/return timingSafeEqual\(digest\(supplied\), digest\(expected\)\)/)
        expect(body).not.toMatch(/supplied\s*[!=]==?\s*expected|expected\s*[!=]==?\s*supplied/)
        expect(source.match(/process\.env\.BOT_CRM_SECRET|\.BOT_CRM_SECRET\b/g)).toEqual(['.BOT_CRM_SECRET'])
    })

    test('outbound calls to the bot refuse a weak secret before any request', async () => {
        const providerFetch = vi.fn()
        vi.stubGlobal('fetch', providerFetch)
        vi.stubEnv('BOT_API_URL', 'http://telegram-bot.internal:3001/api/bot')
        vi.stubEnv('BOT_CRM_SECRET', 'short-secret')
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', 'driver-bot-primary')
        try {
            await expect(sendExactTelegramBotMessageV1({
                providerAccountId: null,
                connectionId: 'driver-bot-primary',
                peerId: '42',
                text: 'hello',
            })).rejects.toThrow('TELEGRAM_BOT_TRANSPORT_AUTH_UNPROVEN')
            expect(providerFetch).not.toHaveBeenCalled()
        } finally {
            vi.unstubAllEnvs()
            vi.unstubAllGlobals()
        }
    })
})

describe('the Driver Bot token comes only from its mounted secret file (T3-6)', () => {
    const TOKEN = '123456789:AAEXAMPLEexampleEXAMPLEexample_-12345'
    let directory: string

    beforeEach(async () => {
        directory = await mkdtemp(join(tmpdir(), 'tg-bot-token-'))
    })

    afterEach(async () => {
        await rm(directory, { recursive: true, force: true })
    })

    test('reads and trims the token from TELEGRAM_BOT_TOKEN_FILE', async () => {
        const file = join(directory, 'token')
        await writeFile(file, `${TOKEN}\n`, { mode: 0o600 })
        await expect(readTelegramBotTokenV1({ TELEGRAM_BOT_TOKEN_FILE: file })).resolves.toBe(TOKEN)
    })

    test('refuses with one bounded code when unset, missing or malformed, and never echoes the token', async () => {
        const malformed = join(directory, 'malformed')
        await writeFile(malformed, 'not-a-token', { mode: 0o600 })
        const empty = join(directory, 'empty')
        await writeFile(empty, '', { mode: 0o600 })
        for (const environment of [
            {},
            { TELEGRAM_BOT_TOKEN_FILE: '' },
            { TELEGRAM_BOT_TOKEN_FILE: join(directory, 'absent') },
            { TELEGRAM_BOT_TOKEN_FILE: malformed },
            { TELEGRAM_BOT_TOKEN_FILE: empty },
            // An environment token is not a fallback: only the file counts.
            { BOT_TOKEN: TOKEN },
        ]) {
            await expect(readTelegramBotTokenV1(environment)).rejects.toThrow(/^TELEGRAM_BOT_TOKEN_UNCONFIGURED$/)
        }
    })
})

describe('T3 source invariants on the CRM side', () => {
    const app = (relative: string) => readFileSync(join(__dirname, '../../../../app', relative), 'utf8')

    test('the media proxy reads the token only through the mounted-file capability and never logs the error', () => {
        const source = app('api/tg-media/[fileId]/route.ts')
        expect(source).toMatch(/token = await readTelegramBotTokenV1\(\)/)
        expect(source).toMatch(/TELEGRAM_BOT_MEDIA_UNCONFIGURED' \}, \{ status: 503 \}/)
        expect(source).not.toMatch(/tg-bot\/\.env|readFileSync|process\.env\.BOT_TOKEN/)
        expect(source).not.toMatch(/console\.error\([^)]*,\s*e\)|error: e\?\.message/)
    })

    test('no CRM route defaults to or documents a personal Telegram id', () => {
        const testCar = app('api/test-car/route.ts')
        expect(testCar).toMatch(/if \(!\/\^\\d\{1,16\}\$\/\.test\(telegramId\)\)/)
        expect(testCar).not.toMatch(/get\('telegramId'\) \|\| '\d+'/)
        expect(app('api/bot-link/route.ts')).not.toMatch(/telegramId=\d{5,}/)
    })
})

