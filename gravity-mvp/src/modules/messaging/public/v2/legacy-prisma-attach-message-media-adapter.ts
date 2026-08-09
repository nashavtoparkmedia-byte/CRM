import { prisma } from '@/lib/prisma'
import type { AttachMessageMediaPersistencePortV2 } from './attach-message-media-handler'

export const legacyPrismaAttachMessageMediaPortV2: AttachMessageMediaPersistencePortV2 = {
    async attach(input) {
        const attachment = await prisma.messageAttachment.create({
            data: {
                messageId: input.messageId,
                type: input.mediaType,
                url: input.url,
                fileName: input.fileName,
                fileSize: input.fileSize,
                mimeType: input.mimeType,
            },
            select: { id: true },
        })
        return { attachmentId: attachment.id }
    },
}
