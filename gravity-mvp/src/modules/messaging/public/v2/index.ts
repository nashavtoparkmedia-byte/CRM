import { createAttachMessageMediaHandlerV2 } from './attach-message-media-handler'
import { legacyPrismaAttachMessageMediaPortV2 } from './legacy-prisma-attach-message-media-adapter'

export { createAttachMessageMediaHandlerV2 } from './attach-message-media-handler'
export type { AttachMessageMediaPersistencePortV2 } from './attach-message-media-handler'
export const attachMessageMediaV2 = createAttachMessageMediaHandlerV2(legacyPrismaAttachMessageMediaPortV2)
