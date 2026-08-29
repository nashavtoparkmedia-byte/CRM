import { broadcastChatMessage } from '@/lib/messageStreamBus'

export function broadcastChatMessageV1(chatId: string, message: unknown): void {
    broadcastChatMessage(chatId, message)
}
