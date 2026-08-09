import { createReceiveMessageHandlerV1 } from './receive-message-handler'
import { legacyPrismaReceiveMessagePortV1 } from './legacy-prisma-receive-message-adapter'
import { createSendMessageHandlerV1 } from './send-message-handler'
import { legacyPrismaSendMessagePortV1 } from './legacy-prisma-send-message-adapter'
import { createUpdateConversationHandlerV1 } from './update-conversation-handler'
import { legacyPrismaUpdateConversationPortV1 } from './legacy-prisma-update-conversation-adapter'

export { createReceiveMessageHandlerV1 } from './receive-message-handler'
export type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
export const receiveMessageV1 = createReceiveMessageHandlerV1(legacyPrismaReceiveMessagePortV1)
export { createSendMessageHandlerV1 } from './send-message-handler'
export type { SendMessagePersistencePortV1 } from './send-message-handler'
export const sendMessageV1 = createSendMessageHandlerV1(legacyPrismaSendMessagePortV1)
export { createUpdateConversationHandlerV1 } from './update-conversation-handler'
export type { UpdateConversationPersistencePortV1 } from './update-conversation-handler'
export const updateConversationV1 = createUpdateConversationHandlerV1(legacyPrismaUpdateConversationPortV1)
