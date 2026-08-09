import { prisma } from '@/lib/prisma'
import type { UpdateConversationPersistencePortV1 } from './update-conversation-handler'

export const legacyPrismaUpdateConversationPortV1: UpdateConversationPersistencePortV1 = {
    async markRequiresResponse(input) {
        const chat = await prisma.chat.update({
            where: { id: input.chatId },
            data: {
                status: 'open',
                requiresResponse: true,
                unreadCount: { increment: 1 },
                lastMessageAt: new Date(input.lastMessageAt),
            },
            select: { id: true },
        })
        return { chatId: chat.id }
    },
}
