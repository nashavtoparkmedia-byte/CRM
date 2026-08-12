import { describe, expect, it, vi } from 'vitest'

import { isRealMaxMessageIdV1, sendMaxReactionDeliveryV1 } from './reaction-delivery'

describe('MAX reaction delivery capability', () => {
    it('rejects CRM and placeholder ids before provider access', async () => {
        const fetchImpl = vi.fn()
        expect(isRealMaxMessageIdV1('d301abcdef0123')).toBe(true)
        expect(isRealMaxMessageIdV1('max-dom-123')).toBe(false)
        await expect(sendMaxReactionDeliveryV1(
            { chatId: '42', messageId: 'max-dom-123', emoji: '👍', remove: false },
            { fetchImpl: fetchImpl as typeof fetch },
        )).rejects.toThrow('real MAX message id')
        expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('does not invent confirmation when MAX only acknowledges a request', async () => {
        const fetchImpl = vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            json: async () => ({ status: 'send_requested' }),
        })
        await expect(sendMaxReactionDeliveryV1(
            { chatId: '42', messageId: 'd301abcdef0123', emoji: '👍', remove: false },
            { endpoint: 'http://max.local/send-reaction', fetchImpl: fetchImpl as typeof fetch },
        )).resolves.toEqual({ reactionConfirmed: false, status: 'send_requested' })
    })
})
