import { createAttachMessageMediaHandlerV2 } from '../public/v2/attach-message-media-handler'
import { legacyPrismaAttachMessageMediaPortV2 } from '../public/v2/legacy-prisma-attach-message-media-adapter'

const attachMessageMedia = createAttachMessageMediaHandlerV2(legacyPrismaAttachMessageMediaPortV2)

export const attachMessageMediaV2 = (...args: Parameters<typeof attachMessageMedia>) => attachMessageMedia(...args)
