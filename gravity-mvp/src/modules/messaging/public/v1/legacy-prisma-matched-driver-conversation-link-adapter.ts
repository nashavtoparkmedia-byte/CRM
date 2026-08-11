import { prisma } from '@/lib/prisma'

import type { MatchedDriverConversationLinkPersistencePortV1 } from './link-matched-driver-to-conversation-handler'

export const legacyPrismaMatchedDriverConversationLinkPortV1: MatchedDriverConversationLinkPersistencePortV1 = {
    async linkMatchedDriverToConversation({ chatId, driverId }) {
        // The null predicate makes the first link atomic. A concurrent or legacy
        // link to a different driver is never overwritten.
        const updated = await prisma.chat.updateMany({
            where: { id: chatId, driverId: null },
            data: { driverId },
        })
        if (updated.count === 1) return true

        const existing = await prisma.chat.findUnique({
            where: { id: chatId },
            select: { driverId: true },
        })
        return existing?.driverId === driverId
    },
}
