import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    broadcastChatMessage: vi.fn(),
}))

vi.mock('@/lib/messageStreamBus', () => operations)

import { broadcastChatMessageV1 } from './message-stream'

describe('Messaging public message stream', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates only the requested chat broadcast', () => {
        const message = { id: 'message-1', metadata: { reactions: { '👍': 1 } } }

        broadcastChatMessageV1('chat-1', message)

        expect(operations.broadcastChatMessage).toHaveBeenCalledTimes(1)
        expect(operations.broadcastChatMessage).toHaveBeenCalledWith('chat-1', message)
    })
})
