import { beforeEach, describe, expect, it, vi } from 'vitest'

import { prisma } from '@/lib/prisma'

import { legacyPrismaBotChatMessagePortV1 } from './legacy-prisma-bot-chat-message-adapter'

vi.mock('@/lib/prisma', () => ({
    prisma: {
        botChatMessage: {
            deleteMany: vi.fn(),
            create: vi.fn(),
        },
    },
}))

const deleteMany = vi.mocked(prisma.botChatMessage.deleteMany)

beforeEach(() => {
    vi.clearAllMocks()
})

describe('legacy pending-link request dismissal', () => {
    it('atomically restricts deletion to an unlinked incoming request message', async () => {
        deleteMany.mockResolvedValue({ count: 0 })

        await expect(legacyPrismaBotChatMessagePortV1.dismiss('ordinary-message')).resolves.toBe(false)
        expect(deleteMany).toHaveBeenCalledWith({
            where: {
                id: 'ordinary-message',
                driverId: null,
                direction: 'INCOMING',
                text: { startsWith: '[Запрос привязки]' },
            },
        })
    })

    it('reports deletion only when the pending request predicate matched', async () => {
        deleteMany.mockResolvedValue({ count: 1 })

        await expect(legacyPrismaBotChatMessagePortV1.dismiss('pending-request')).resolves.toBe(true)
    })
})
