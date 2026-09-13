import { beforeEach, describe, expect, it, vi } from 'vitest'

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
        const maxText = vi.fn().mockResolvedValue({ externalId: 'max-1' })
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
            sendText: maxText,
            sendMedia: vi.fn(),
            sendReaction: vi.fn(),
        })

        await expect(getWhatsAppChannelDeliveryV1().sendText({ chatId: '79990000000', content: 'hello' }))
            .resolves.toEqual({ externalId: 'wa-1' })
        await getTelegramChannelDeliveryV1().sendText({ target: '42', content: 'hello' })
        await getMaxChannelDeliveryV1().sendText({ target: 'max:42', content: 'hello' })

        expect(whatsappText).toHaveBeenCalledWith({ chatId: '79990000000', content: 'hello' })
        expect(telegramText).toHaveBeenCalledWith({ target: '42', content: 'hello' })
        expect(maxText).toHaveBeenCalledWith({ target: 'max:42', content: 'hello' })
    })
})

/**
 * Regression: the production build emits this module into many server chunks,
 * and `instrumentation` lands in its own. Importing it once, as the test above
 * does, cannot see that: a single module instance always agrees with itself.
 *
 * `vi.resetModules()` between two dynamic imports gives two genuinely separate
 * module instances, which is what separate chunks produce at runtime. Against
 * module-scoped state these tests fail with "capability is not registered" —
 * the exact production symptom, on all three channels.
 */
describe('Channel delivery registry across separate module instances', () => {
    const stubCapability = (id: string) => ({
        sendText: vi.fn().mockResolvedValue({ externalId: id }),
        sendMedia: vi.fn(),
        sendReaction: vi.fn(),
    })

    beforeEach(() => {
        vi.resetModules()
        delete (globalThis as Record<symbol, unknown>)[
            Symbol.for('yoko.messaging.channel-delivery-registry.v1')
        ]
    })

    it('resolves a capability registered through a different module instance', async () => {
        const registrar = await import('./channel-delivery-runtime')
        registrar.registerMaxChannelDeliveryV1(stubCapability('max-cross-chunk') as never)

        vi.resetModules()
        const consumer = await import('./channel-delivery-runtime')

        expect(consumer).not.toBe(registrar)
        await expect(
            consumer.getMaxChannelDeliveryV1().sendText({ target: 'max:42', content: 'hello' }),
        ).resolves.toEqual({ externalId: 'max-cross-chunk' })
    })

    it('does the same for Telegram and WhatsApp', async () => {
        const registrar = await import('./channel-delivery-runtime')
        registrar.registerTelegramChannelDeliveryV1(stubCapability('tg-cross-chunk') as never)
        registrar.registerWhatsAppChannelDeliveryV1(stubCapability('wa-cross-chunk') as never)

        vi.resetModules()
        const consumer = await import('./channel-delivery-runtime')

        await expect(
            consumer.getTelegramChannelDeliveryV1().sendText({ target: '42', content: 'hello' }),
        ).resolves.toEqual({ externalId: 'tg-cross-chunk' })
        await expect(
            consumer.getWhatsAppChannelDeliveryV1().sendText({ chatId: '42', content: 'hello' }),
        ).resolves.toEqual({ externalId: 'wa-cross-chunk' })
    })

    it('reports readiness truthfully, and reports it across instances too', async () => {
        const registrar = await import('./channel-delivery-runtime')
        expect(registrar.channelDeliveryRegistrationStatusV1()).toEqual({
            ready: false,
            registered: [],
            missing: ['whatsapp', 'telegram', 'max'],
        })

        registrar.registerWhatsAppChannelDeliveryV1(stubCapability('wa') as never)
        registrar.registerTelegramChannelDeliveryV1(stubCapability('tg') as never)
        expect(registrar.channelDeliveryRegistrationStatusV1().missing).toEqual(['max'])

        registrar.registerMaxChannelDeliveryV1(stubCapability('max') as never)

        vi.resetModules()
        const consumer = await import('./channel-delivery-runtime')
        expect(consumer.channelDeliveryRegistrationStatusV1()).toEqual({
            ready: true,
            registered: ['whatsapp', 'telegram', 'max'],
            missing: [],
        })
    })

    it('still throws, per channel, when nothing was ever registered', async () => {
        const consumer = await import('./channel-delivery-runtime')
        expect(() => consumer.getMaxChannelDeliveryV1()).toThrow(/MAX channel delivery capability is not registered/)
        expect(() => consumer.getTelegramChannelDeliveryV1()).toThrow(/Telegram channel delivery capability is not registered/)
        expect(() => consumer.getWhatsAppChannelDeliveryV1()).toThrow(/WhatsApp channel delivery capability is not registered/)
    })
})
