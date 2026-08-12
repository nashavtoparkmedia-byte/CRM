import { ConversationWorkflowService } from '@/lib/ConversationWorkflowService'

export const channelConversationWorkflowV1 = Object.freeze({
    onInboundMessage: (chatId: string, sentAt: Date): Promise<void> => (
        ConversationWorkflowService.onInboundMessage(chatId, sentAt)
    ),
    onGroupInboundMessage: (chatId: string, sentAt: Date): Promise<void> => (
        ConversationWorkflowService.onGroupInboundMessage(chatId, sentAt)
    ),
    onOutboundMessage: (chatId: string, sentAt: Date): Promise<void> => (
        ConversationWorkflowService.onOutboundMessage(chatId, sentAt)
    ),
})
