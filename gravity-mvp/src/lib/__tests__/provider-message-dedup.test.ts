import { describe, expect, it } from 'vitest'
import {
    buildProviderMessageDedupWhere,
    buildScopedProviderMessageId,
    readRawProviderMessageId,
} from '@/lib/provider-message-dedup'

const sentAt = new Date('2026-07-18T12:00:00.000Z')

describe('provider message dedup contract', () => {
    it('uses the provider ID alone for inbound events with a stable ID', () => {
        expect(buildProviderMessageDedupWhere({
            externalId: 'provider-1',
            chatId: 'chat-1',
            content: 'Одинаковый текст',
            direction: 'inbound',
            sentAt,
            fallbackWindowMs: 5000,
        })).toEqual({ externalId: 'provider-1' })

        expect(buildProviderMessageDedupWhere({
            externalId: 'provider-2',
            chatId: 'chat-1',
            content: 'Одинаковый текст',
            direction: 'inbound',
            sentAt,
            fallbackWindowMs: 5000,
        })).toEqual({ externalId: 'provider-2' })
    })

    it('reconciles an outbound echo only with a still-optimistic row', () => {
        expect(buildProviderMessageDedupWhere({
            externalId: 'provider-out-1',
            chatId: 'chat-1',
            content: 'Повтор',
            direction: 'outbound',
            sentAt,
            fallbackWindowMs: 30000,
            allowOptimisticOutbound: true,
        })).toEqual({
            OR: [
                { externalId: 'provider-out-1' },
                {
                    chatId: 'chat-1',
                    content: 'Повтор',
                    direction: 'outbound',
                    sentAt: {
                        gte: new Date('2026-07-18T11:59:30.000Z'),
                        lte: new Date('2026-07-18T12:00:30.000Z'),
                    },
                    externalId: null,
                    status: 'sent',
                },
            ],
        })
    })

    it('uses a bounded fingerprint only when no provider ID exists', () => {
        const where = buildProviderMessageDedupWhere({
            externalId: null,
            chatId: 'chat-legacy',
            content: 'Legacy event',
            direction: 'inbound',
            sentAt,
            fallbackWindowMs: 2000,
        })

        expect(where).toMatchObject({
            chatId: 'chat-legacy',
            content: 'Legacy event',
            direction: 'inbound',
        })
        expect(where).not.toHaveProperty('OR')
        expect(where).not.toHaveProperty('externalId')
    })

    it('scopes Telegram Bot message IDs by chat and preserves the raw ID', () => {
        const first = buildScopedProviderMessageId('telegram-bot', '100500', 71)
        const second = buildScopedProviderMessageId('telegram-bot', '200600', 71)

        expect(first).toBe('telegram-bot:100500:71')
        expect(second).toBe('telegram-bot:200600:71')
        expect(first).not.toBe(second)
        expect(readRawProviderMessageId(first)).toBe('71')
        expect(readRawProviderMessageId('legacy-raw-id')).toBe('legacy-raw-id')
    })
})
