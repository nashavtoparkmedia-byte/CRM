import { createReceiveMessageHandlerV1 } from './receive-message-handler'
import { legacyPrismaReceiveMessagePortV1 } from './legacy-prisma-receive-message-adapter'
import { createSendMessageHandlerV1 } from './send-message-handler'
import { legacyPrismaSendMessagePortV1 } from './legacy-prisma-send-message-adapter'

export { createReceiveMessageHandlerV1 } from './receive-message-handler'
export type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
export const receiveMessageV1 = createReceiveMessageHandlerV1(legacyPrismaReceiveMessagePortV1)
export { createSendMessageHandlerV1 } from './send-message-handler'
export type { SendMessagePersistencePortV1 } from './send-message-handler'
export const sendMessageV1 = createSendMessageHandlerV1(legacyPrismaSendMessagePortV1)
