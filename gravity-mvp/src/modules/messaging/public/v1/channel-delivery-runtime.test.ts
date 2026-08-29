import { describe, expect, it, vi } from 'vitest'

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
