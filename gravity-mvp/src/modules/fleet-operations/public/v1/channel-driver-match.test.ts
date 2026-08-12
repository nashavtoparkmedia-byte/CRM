import { describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    linkChatToDriver: vi.fn(),
}))

vi.mock('@/lib/DriverMatchService', () => ({ DriverMatchService: operations }))

import { channelDriverMatchV1 } from './channel-driver-match'

describe('Fleet channel driver match', () => {
    it('delegates only the strict chat-link match', async () => {
        const linkMatchedDriver = vi.fn()
        operations.linkChatToDriver.mockResolvedValueOnce(true)

        await expect(channelDriverMatchV1.linkChatToDriver(
            'chat-1',
            { telegramId: '123', phone: '+79990000000', name: 'Diagnostic only' },
            linkMatchedDriver,
        )).resolves.toBe(true)

        expect(operations.linkChatToDriver).toHaveBeenCalledWith(
            'chat-1',
            { telegramId: '123', phone: '+79990000000', name: 'Diagnostic only' },
            linkMatchedDriver,
        )
    })
})
