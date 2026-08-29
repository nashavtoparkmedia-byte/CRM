import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    onInboundMessage: vi.fn(),
    onGroupInboundMessage: vi.fn(),
    onOutboundMessage: vi.fn(),
}))

vi.mock('@/lib/ConversationWorkflowService', () => ({
    ConversationWorkflowService: operations,
}))

import { channelConversationWorkflowV1 } from './channel-conversation-workflow'

describe('Messaging channel conversation workflow', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates the three exact channel transitions', async () => {
        const sentAt = new Date('2026-08-11T00:00:00.000Z')

        await channelConversationWorkflowV1.onInboundMessage('chat-1', sentAt)
        await channelConversationWorkflowV1.onGroupInboundMessage('chat-2', sentAt)
        await channelConversationWorkflowV1.onOutboundMessage('chat-3', sentAt)

        expect(operations.onInboundMessage).toHaveBeenCalledWith('chat-1', sentAt)
        expect(operations.onGroupInboundMessage).toHaveBeenCalledWith('chat-2', sentAt)
        expect(operations.onOutboundMessage).toHaveBeenCalledWith('chat-3', sentAt)
    })
})
