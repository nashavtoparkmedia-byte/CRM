import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ emitMessageReceived: vi.fn() }))
vi.mock('@/lib/messageEvents', () => runtime)

import { publishPersistedMessageV1 } from './persisted-message-ingress'

describe('publishPersistedMessageV1', () => {
    beforeEach(() => runtime.emitMessageReceived.mockReset())

    it('passes the exact persisted record to the Messaging runtime', async () => {
        const message = {
            id: 'message-1',
            chatId: 'chat-1',
            direction: 'inbound' as const,
            type: 'text' as const,
            content: 'hello',
            status: 'delivered' as const,
            externalId: 'provider-1',
            metadata: { provider: 'telegram' },
            sentAt: new Date('2026-08-12T00:00:00Z'),
            createdAt: new Date('2026-08-12T00:00:01Z'),
            updatedAt: new Date('2026-08-12T00:00:02Z'),
            channel: 'telegram' as const,
            aiStatus: null,
            clientMessageId: null,
        }

        runtime.emitMessageReceived.mockResolvedValue(undefined)
        await publishPersistedMessageV1(message)

        expect(runtime.emitMessageReceived).toHaveBeenCalledTimes(1)
        expect(runtime.emitMessageReceived).toHaveBeenCalledWith(message)
        expect(runtime.emitMessageReceived.mock.calls[0][0]).toBe(message)
    })
})
