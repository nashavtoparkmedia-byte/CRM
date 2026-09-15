import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
    getMaxChannelDeliveryV1,
    getTelegramChannelDeliveryV1,
    getWhatsAppChannelDeliveryV1,
    registerMaxChannelDeliveryV1,
    registerTelegramChannelDeliveryV1,
    registerWhatsAppChannelDeliveryV1,
} from './channel-delivery-runtime'

describe('Messaging channel delivery runtime ports', () => {
    it('keeps provider transport behind registered narrow channel capabilities', async () => {
        const whatsappText = vi.fn().mockResolvedValue({ externalId: 'wa-1' })
        const telegramText = vi.fn().mockResolvedValue({ externalId: 'tg-1' })
        const maxText = vi.fn().mockResolvedValue({
            outcome: 'delivered',
            externalId: 'max-1',
            resolvedChatId: null,
        })
        registerWhatsAppChannelDeliveryV1({
            sendText: whatsappText,
            sendMedia: vi.fn(),
            sendReaction: vi.fn(),
        })
        registerTelegramChannelDeliveryV1({
            sendText: telegramText,
            sendMedia: vi.fn(),
            sendReaction: vi.fn(),
        })
        registerMaxChannelDeliveryV1({
            assertTransportBinding: vi.fn(),
            sendText: maxText,
            sendMedia: vi.fn(),
            sendReaction: vi.fn(),
            deleteMessage: vi.fn(),
        })

        await expect(getWhatsAppChannelDeliveryV1().sendText({ chatId: '79990000000', content: 'hello' }))
            .resolves.toEqual({ externalId: 'wa-1' })
        await getTelegramChannelDeliveryV1().sendText({ target: '42', content: 'hello' })
        await getMaxChannelDeliveryV1().sendText({
            target: 'max:42',
            content: 'hello',
            options: { providerAccountId: 'max-account-42', isPersonal: true },
        })

        expect(whatsappText).toHaveBeenCalledWith({ chatId: '79990000000', content: 'hello' })
        expect(telegramText).toHaveBeenCalledWith({ target: '42', content: 'hello' })
        expect(maxText).toHaveBeenCalledWith({
            target: 'max:42',
            content: 'hello',
            options: { providerAccountId: 'max-account-42', isPersonal: true },
        })
    })
})

const REGISTRY_SLOT = Symbol.for('yoko.messaging.channel-delivery-registry.v1')

type RuntimeCopy = typeof import('./channel-delivery-runtime')

/** A fresh, independently evaluated copy of the module, as a separate Next.js chunk would load it. */
async function loadIndependentCopy(): Promise<RuntimeCopy> {
    vi.resetModules()
    return import('./channel-delivery-runtime')
}

function maxCapability() {
    return {
        assertTransportBinding: vi.fn(),
        sendText: vi.fn().mockResolvedValue({ outcome: 'delivered', externalId: null, resolvedChatId: null }),
        sendMedia: vi.fn(),
        sendReaction: vi.fn(),
        deleteMessage: vi.fn(),
    }
}

describe('Messaging channel delivery registry is process-wide', () => {
    beforeEach(() => {
        delete (globalThis as Record<symbol, unknown>)[REGISTRY_SLOT]
    })
    afterEach(() => {
        delete (globalThis as Record<symbol, unknown>)[REGISTRY_SLOT]
    })

    it('shares one registration across independently loaded module copies', async () => {
        const registeringCopy = await loadIndependentCopy()
        const sendingCopy = await loadIndependentCopy()
        // Guard against a vacuous pass: these really are two separate evaluations.
        expect(sendingCopy).not.toBe(registeringCopy)
        expect(sendingCopy.getMaxChannelDeliveryV1).not.toBe(registeringCopy.getMaxChannelDeliveryV1)

        const whatsapp = { sendText: vi.fn(), sendMedia: vi.fn(), sendReaction: vi.fn() }
        const telegram = { sendText: vi.fn(), sendMedia: vi.fn(), sendReaction: vi.fn() }
        const max = maxCapability()
        registeringCopy.registerWhatsAppChannelDeliveryV1(whatsapp)
        registeringCopy.registerTelegramChannelDeliveryV1(telegram)
        registeringCopy.registerMaxChannelDeliveryV1(max)

        expect(sendingCopy.getWhatsAppChannelDeliveryV1()).toBe(whatsapp)
        expect(sendingCopy.getTelegramChannelDeliveryV1()).toBe(telegram)
        expect(sendingCopy.getMaxChannelDeliveryV1()).toBe(max)
    })

    it('still fails closed in every copy when nothing was registered', async () => {
        const copy = await loadIndependentCopy()
        expect(() => copy.getWhatsAppChannelDeliveryV1()).toThrow('WhatsApp channel delivery capability is not registered')
        expect(() => copy.getTelegramChannelDeliveryV1()).toThrow('Telegram channel delivery capability is not registered')
        expect(() => copy.getMaxChannelDeliveryV1()).toThrow('MAX channel delivery capability is not registered')
    })

    it('keeps last-write-wins registration, visible from a copy loaded earlier', async () => {
        const early = await loadIndependentCopy()
        const late = await loadIndependentCopy()
        const first = maxCapability()
        const second = maxCapability()
        late.registerMaxChannelDeliveryV1(first)
        late.registerMaxChannelDeliveryV1(second)
        expect(early.getMaxChannelDeliveryV1()).toBe(second)
    })

    it('rejects a return to module-scoped capability slots', () => {
        const source = readFileSync(resolve(__dirname, 'channel-delivery-runtime.ts'), 'utf8')
        // A module-scoped `let` is exactly the storage that splits across chunks.
        expect(source).not.toMatch(/^\s*(let|var)\s+\w*Delivery\b/m)
        expect(source).toContain("Symbol.for('yoko.messaging.channel-delivery-registry.v1')")
        expect(source).toContain('globalThis')
    })
})
