import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/provider-contracts/whatsapp-events.json'
import {
    canonicalWhatsAppExternalChatId,
    isOpaqueWhatsAppLid,
    isPrivateWhatsAppPhoneJid,
    isWhatsAppGroupJid,
    mapWhatsAppMessageType,
    resolveWhatsAppQuotedMessageId,
    whatsAppContentWithFallback,
} from '@/lib/whatsapp/whatsapp-message-contract'
import { buildProviderMessageDedupWhere } from '@/lib/provider-message-dedup'

describe('WhatsApp provider contract fixtures', () => {
    it('distinguishes private phone, opaque LID, and group JIDs', () => {
        expect(isPrivateWhatsAppPhoneJid(fixtures.private.jid)).toBe(true)
        expect(canonicalWhatsAppExternalChatId(fixtures.private.jid))
            .toBe('whatsapp:79222155750')

        expect(isOpaqueWhatsAppLid(fixtures.lid.jid)).toBe(true)
        expect(canonicalWhatsAppExternalChatId(fixtures.lid.jid))
            .toBe(fixtures.lid.jid)

        expect(isWhatsAppGroupJid(fixtures.group.jid)).toBe(true)
        expect(canonicalWhatsAppExternalChatId(fixtures.group.jid))
            .toBe(fixtures.group.jid)
    })

    it('preserves repeated inbound text when provider IDs differ', () => {
        const queries = fixtures.repeatedInbound.map(event =>
            buildProviderMessageDedupWhere({
                externalId: event.providerMessageId,
                chatId: 'chat-wa',
                content: event.body,
                direction: 'inbound',
                sentAt: new Date(event.timestamp),
                fallbackWindowMs: 10000,
            }),
        )

        expect(queries).toEqual([
            { externalId: fixtures.repeatedInbound[0].providerMessageId },
            { externalId: fixtures.repeatedInbound[1].providerMessageId },
        ])
    })

    it('keeps media type/content separate and keeps reply IDs structured', async () => {
        expect(mapWhatsAppMessageType(fixtures.media.type)).toBe('image')
        expect(whatsAppContentWithFallback(fixtures.media.body, fixtures.media.type))
            .toBe('[Фото]')
        expect(fixtures.reply.body).not.toContain(fixtures.reply.quotedProviderMessageId)
        expect(fixtures.reply.quotedProviderMessageId).toMatch(/^true_/)
        await expect(resolveWhatsAppQuotedMessageId({
            hasQuotedMsg: true,
            getQuotedMessage: async () => ({
                id: { _serialized: fixtures.reply.quotedProviderMessageId },
            }),
        })).resolves.toBe(fixtures.reply.quotedProviderMessageId)
    })

    it('wires actual service paths to strict dedup and reaction helpers', () => {
        const source = readFileSync(
            resolve(process.cwd(), 'src/lib/whatsapp/WhatsAppService.ts'),
            'utf8',
        )

        expect(source).toContain('buildProviderMessageDedupWhere({')
        expect(source).toContain("client.on('message_reaction'")
        expect(source).toContain('applyProviderReactionEvent(message.metadata')
        expect(source).toContain('allowOptimisticOutbound: isOutbound')
    })
})
