import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
    TELEGRAM_BOT_CONNECTION_ENV_NAME,
    canonicalTelegramBotConnectionIdV1,
} from './bot-transport-config'

const UNPROVEN = 'TELEGRAM_BOT_CONNECTION_CONFIG_UNPROVEN'

describe('canonical Telegram Bot transport configuration', () => {
    afterEach(() => {
        vi.unstubAllEnvs()
    })

    test('owns exactly the canonical configuration name', () => {
        expect(TELEGRAM_BOT_CONNECTION_ENV_NAME).toBe('CRM_TELEGRAM_CONNECTION_ID')
    })

    test('accepts the canonical production value', () => {
        expect(canonicalTelegramBotConnectionIdV1({
            CRM_TELEGRAM_CONNECTION_ID: 'driver-bot-primary',
        })).toBe('driver-bot-primary')
    })

    test('reads the canonical name from the process environment by default', () => {
        vi.stubEnv('CRM_TELEGRAM_CONNECTION_ID', 'driver-bot-primary')
        expect(canonicalTelegramBotConnectionIdV1()).toBe('driver-bot-primary')
    })

    test('fails closed when unconfigured', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({})).toThrow(UNPROVEN)
    })

    test('fails closed on an explicitly undefined value', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            CRM_TELEGRAM_CONNECTION_ID: undefined,
        })).toThrow(UNPROVEN)
    })

    test('fails closed on an empty value', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            CRM_TELEGRAM_CONNECTION_ID: '',
        })).toThrow(UNPROVEN)
    })

    test('fails closed on a whitespace-only value', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            CRM_TELEGRAM_CONNECTION_ID: '   ',
        })).toThrow(UNPROVEN)
    })

    test('fails closed on an untrimmed value', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            CRM_TELEGRAM_CONNECTION_ID: ' driver-bot-primary ',
        })).toThrow(UNPROVEN)
    })

    test.each(['legacy', 'telegram-default'])(
        'fails closed on the %s placeholder',
        placeholder => {
            expect(() => canonicalTelegramBotConnectionIdV1({
                CRM_TELEGRAM_CONNECTION_ID: placeholder,
            })).toThrow(UNPROVEN)
        },
    )

    test('does not fall back to TELEGRAM_CONNECTION_ID', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            TELEGRAM_CONNECTION_ID: 'driver-bot-primary',
        })).toThrow(UNPROVEN)
    })

    test('does not fall back to the MTProto personal-account connection', () => {
        expect(() => canonicalTelegramBotConnectionIdV1({
            TELEGRAM_CONNECTION_ID: '1982527911',
        })).toThrow(UNPROVEN)
    })

    test('carries no hardcoded canonical value and never reads the database', () => {
        const source = readFileSync(
            join(__dirname, 'bot-transport-config.ts'),
            'utf8',
        )
        // Assert on executable code only: the prose deliberately explains why
        // TelegramConnection and the database are excluded, so naming them in a
        // comment must not fail this proof.
        const code = source
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/.*$/gm, '')

        // Configuration-owned: the product value must not be baked into code.
        expect(code).not.toContain('driver-bot-primary')
        // Dependency-free: no transport can be discovered from a row.
        expect(code).not.toMatch(/\bimport\b/)
        expect(code).not.toContain('TelegramConnection')
        expect(code).not.toMatch(/prisma/i)
        // The only accepted name is the canonical one; the bare fallback that the
        // bot tolerates must not be readable here.
        expect(code).not.toMatch(/(?<!CRM_)TELEGRAM_CONNECTION_ID/)
    })
})
