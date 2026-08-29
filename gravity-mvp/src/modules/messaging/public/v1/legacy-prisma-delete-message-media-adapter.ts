import { prisma } from '@/lib/prisma'
import type { DeleteMessageMediaPersistencePortV1 } from './delete-message-media-handler'

export const legacyPrismaDeleteMessageMediaPortV1: DeleteMessageMediaPersistencePortV1 = {
    async deleteAllForMessage(input) {
        const result = await prisma.messageAttachment.deleteMany({ where: { messageId: input.messageId } })
        return { deletedCount: result.count }
    },
}
