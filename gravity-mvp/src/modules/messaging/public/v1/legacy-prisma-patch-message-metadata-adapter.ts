import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/prisma'
import type { PatchMessageMetadataPersistencePortV1 } from './patch-message-metadata-handler'
export const legacyPrismaPatchMessageMetadataPortV1: PatchMessageMetadataPersistencePortV1 = {
    async patchMetadata(messageId, metadata) {
        await prisma.message.update({ where: { id: messageId }, data: { metadata: metadata as Prisma.InputJsonValue } })
    },
}
