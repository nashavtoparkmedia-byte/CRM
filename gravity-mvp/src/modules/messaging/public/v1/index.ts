import { createReceiveMessageHandlerV1 } from './receive-message-handler'
import { legacyPrismaReceiveMessagePortV1 } from './legacy-prisma-receive-message-adapter'

export { createReceiveMessageHandlerV1 } from './receive-message-handler'
export type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
export const receiveMessageV1 = createReceiveMessageHandlerV1(legacyPrismaReceiveMessagePortV1)
