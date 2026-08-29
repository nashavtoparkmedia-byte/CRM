import { createAttachMessageMediaHandlerV1 } from '../public/v1/attach-message-media-handler'
import { legacyPrismaAttachMessageMediaPortV1 } from '../public/v1/legacy-prisma-attach-message-media-adapter'
import { createDeleteMessageMediaHandlerV1 } from '../public/v1/delete-message-media-handler'
import { legacyPrismaDeleteMessageMediaPortV1 } from '../public/v1/legacy-prisma-delete-message-media-adapter'
import { createReceiveMessageHandlerV1 } from '../public/v1/receive-message-handler'
import { legacyPrismaReceiveMessagePortV1 } from '../public/v1/legacy-prisma-receive-message-adapter'
import { createSendMessageHandlerV1 } from '../public/v1/send-message-handler'
import { legacyPrismaSendMessagePortV1 } from '../public/v1/legacy-prisma-send-message-adapter'
import { createUpdateConversationHandlerV1 } from '../public/v1/update-conversation-handler'
import { legacyPrismaUpdateConversationPortV1 } from '../public/v1/legacy-prisma-update-conversation-adapter'
import {
    createCancelHistoryImportJobHandlerV1,
    createDeleteHistoryImportJobsForChannelHandlerV1,
    createDeleteHistoryImportJobsForConnectionHandlerV1,
    createDeleteHistoryImportJobHandlerV1,
    createPatchHistoryImportJobHandlerV1,
    createQueueHistoryImportJobHandlerV1,
    createUpdateHistoryImportJobHandlerV1,
} from '../public/v1/history-import-job-handler'
import { legacyPrismaHistoryImportJobPortV1 } from '../public/v1/legacy-prisma-history-import-job-adapter'
import { createSyncCallTimelineHandlerV1 } from '../public/v1/sync-call-timeline-handler'
import { legacyPrismaSyncCallTimelinePortV1 } from '../public/v1/legacy-prisma-sync-call-timeline-adapter'
import { broadcastChatMessage } from '@/lib/messageStreamBus'
import { createCompletedCallTimelineMessagingProjectorV1 } from '../public/v1/completed-call-timeline-projector'
import { createCreateCommunicationTriggerHandlerV1, createDeleteCommunicationTriggerHandlerV1, createUpdateCommunicationTriggerHandlerV1 } from '../public/v1/communication-trigger-handler'
import { legacyPrismaCommunicationTriggerPortV1 } from '../public/v1/legacy-prisma-communication-trigger-adapter'
import { createEnsureLeadConversationHandlerV1, createResolveConversationHandlerV1 } from '../public/v1/lead-conversation-handler'
import { legacyPrismaLeadConversationPortV1 } from '../public/v1/legacy-prisma-lead-conversation-adapter'
import { createClaimMessageEventHandlerV1, createCompleteMessageEventHandlerV1, createFailMessageEventHandlerV1 } from '../public/v1/message-event-log-handler'
import { legacyPrismaMessageEventLogPortV1 } from '../public/v1/legacy-prisma-message-event-log-adapter'
import { createDeleteMessageHandlerV1, createReplaceExternalMessageHandlerV1, createUpsertExternalMessageHandlerV1 } from '../public/v1/external-message-handler'
import { legacyPrismaExternalMessagePortV1 } from '../public/v1/legacy-prisma-external-message-adapter'
import { createCreateExternalConversationHandlerV1, createPatchExternalConversationHandlerV1 } from '../public/v1/external-conversation-handler'
import { legacyPrismaExternalConversationPortV1 } from '../public/v1/legacy-prisma-external-conversation-adapter'
import { createCreateChannelMessageHandlerV1, createPatchMessageDeliveryHandlerV1 } from '../public/v1/channel-message-handler'
import { legacyPrismaChannelMessagePortV1 } from '../public/v1/legacy-prisma-channel-message-adapter'
import { createPatchChannelConversationHandlerV1, createUpsertChannelConversationHandlerV1 } from '../public/v1/channel-conversation-handler'
import { legacyPrismaChannelConversationPortV1 } from '../public/v1/legacy-prisma-channel-conversation-adapter'
import { createDeleteRetainedMessagesHandlerV1, createPurgeMessageRetryMetadataHandlerV1 } from '../public/v1/message-retention-handler'
import { legacyPrismaMessageRetentionPortV1 } from '../public/v1/legacy-prisma-message-retention-adapter'
import { createAttachBinaryMessageMediaHandlerV1 } from '../public/v1/attach-binary-message-media-handler'
import { legacyPrismaAttachBinaryMessageMediaPortV1 } from '../public/v1/legacy-prisma-attach-binary-message-media-adapter'
import { createDeleteConversationsByIdHandlerV1, createDeleteLegacyExternalConversationsHandlerV1, createDeleteQueuedMessagesForConnectionHandlerV1, createDeliverQueuedMessagesForConnectionHandlerV1 } from '../public/v1/channel-maintenance-handler'
import { legacyPrismaChannelMaintenancePortV1 } from '../public/v1/legacy-prisma-channel-maintenance-adapter'
import { createDetachContactConversationsHandlerV1 } from '../public/v1/contact-retention-handler'
import { legacyPrismaContactConversationRetentionPortV1 } from '../public/v1/legacy-prisma-contact-retention-adapter'
import { createEnsureConversationContactLinkHandlerV1 } from '../public/v1/conversation-contact-link-handler'
import { legacyPrismaConversationContactLinkPortV1 } from '../public/v1/legacy-prisma-conversation-contact-link-adapter'
import { createFindAndBackfillContactConversationHandlerV1, createOpenFallbackContactConversationHandlerV1 } from '../public/v1/contact-conversation-handler'
import { legacyPrismaContactConversationPortV1 } from '../public/v1/legacy-prisma-contact-conversation-adapter'
import { createPatchMessageMetadataHandlerV1 } from '../public/v1/patch-message-metadata-handler'
import { legacyPrismaPatchMessageMetadataPortV1 } from '../public/v1/legacy-prisma-patch-message-metadata-adapter'
import { createDeleteConversationsByChannelHandlerV1 } from '../public/v1/delete-conversations-by-channel-handler'
import { legacyPrismaDeleteConversationsByChannelPortV1 } from '../public/v1/legacy-prisma-delete-conversations-by-channel-adapter'
import { createLinkMatchedDriverToConversationHandlerV1 } from '../public/v1/link-matched-driver-to-conversation-handler'
import { legacyPrismaMatchedDriverConversationLinkPortV1 } from '../public/v1/legacy-prisma-matched-driver-conversation-link-adapter'
import { LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1 } from '@/contracts/messaging/v1'

const attachMessageMedia = createAttachMessageMediaHandlerV1(legacyPrismaAttachMessageMediaPortV1)
const deleteMessageMedia = createDeleteMessageMediaHandlerV1(legacyPrismaDeleteMessageMediaPortV1)
const receiveMessage = createReceiveMessageHandlerV1(legacyPrismaReceiveMessagePortV1)
const sendMessage = createSendMessageHandlerV1(legacyPrismaSendMessagePortV1)
const updateConversation = createUpdateConversationHandlerV1(legacyPrismaUpdateConversationPortV1)
const deleteHistoryImportJob = createDeleteHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
const updateHistoryImportJob = createUpdateHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
const deleteHistoryImportJobsForConnection = createDeleteHistoryImportJobsForConnectionHandlerV1(legacyPrismaHistoryImportJobPortV1)
const patchHistoryImportJob = createPatchHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
const deleteHistoryImportJobsForChannel = createDeleteHistoryImportJobsForChannelHandlerV1(legacyPrismaHistoryImportJobPortV1)
const queueHistoryImportJob = createQueueHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
const cancelHistoryImportJob = createCancelHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
const syncCallTimeline = createSyncCallTimelineHandlerV1(legacyPrismaSyncCallTimelinePortV1)
const createCommunicationTrigger = createCreateCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
const updateCommunicationTrigger = createUpdateCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
const deleteCommunicationTrigger = createDeleteCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
const ensureLeadConversation = createEnsureLeadConversationHandlerV1(legacyPrismaLeadConversationPortV1)
const resolveConversation = createResolveConversationHandlerV1(legacyPrismaLeadConversationPortV1)
const claimMessageEvent = createClaimMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
const completeMessageEvent = createCompleteMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
const failMessageEvent = createFailMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
const deleteMessage = createDeleteMessageHandlerV1(legacyPrismaExternalMessagePortV1)
const replaceExternalMessage = createReplaceExternalMessageHandlerV1(legacyPrismaExternalMessagePortV1)
const upsertExternalMessage = createUpsertExternalMessageHandlerV1(legacyPrismaExternalMessagePortV1)
const patchExternalConversation = createPatchExternalConversationHandlerV1(legacyPrismaExternalConversationPortV1)
const createExternalConversation = createCreateExternalConversationHandlerV1(legacyPrismaExternalConversationPortV1)
const createChannelMessage = createCreateChannelMessageHandlerV1(legacyPrismaChannelMessagePortV1)
const patchMessageDelivery = createPatchMessageDeliveryHandlerV1(legacyPrismaChannelMessagePortV1)
const upsertChannelConversation = createUpsertChannelConversationHandlerV1(legacyPrismaChannelConversationPortV1)
const patchChannelConversation = createPatchChannelConversationHandlerV1(legacyPrismaChannelConversationPortV1)
const deleteRetainedMessages = createDeleteRetainedMessagesHandlerV1(legacyPrismaMessageRetentionPortV1)
const purgeMessageRetryMetadata = createPurgeMessageRetryMetadataHandlerV1(legacyPrismaMessageRetentionPortV1)
const attachBinaryMessageMedia = createAttachBinaryMessageMediaHandlerV1(legacyPrismaAttachBinaryMessageMediaPortV1)
const deliverQueuedMessagesForConnection = createDeliverQueuedMessagesForConnectionHandlerV1(legacyPrismaChannelMaintenancePortV1)
const deleteQueuedMessagesForConnection = createDeleteQueuedMessagesForConnectionHandlerV1(legacyPrismaChannelMaintenancePortV1)
const deleteLegacyExternalConversations = createDeleteLegacyExternalConversationsHandlerV1(legacyPrismaChannelMaintenancePortV1)
const deleteConversationsById = createDeleteConversationsByIdHandlerV1(legacyPrismaChannelMaintenancePortV1)
const detachContactConversations = createDetachContactConversationsHandlerV1(legacyPrismaContactConversationRetentionPortV1)
const ensureConversationContactLink = createEnsureConversationContactLinkHandlerV1(legacyPrismaConversationContactLinkPortV1)
const findAndBackfillContactConversation = createFindAndBackfillContactConversationHandlerV1(legacyPrismaContactConversationPortV1)
const openFallbackContactConversation = createOpenFallbackContactConversationHandlerV1(legacyPrismaContactConversationPortV1)
const patchMessageMetadata = createPatchMessageMetadataHandlerV1(legacyPrismaPatchMessageMetadataPortV1)
const deleteConversationsByChannel = createDeleteConversationsByChannelHandlerV1(legacyPrismaDeleteConversationsByChannelPortV1)
const linkMatchedDriverToConversationCommand = createLinkMatchedDriverToConversationHandlerV1(legacyPrismaMatchedDriverConversationLinkPortV1)

export const attachMessageMediaV1 = (...args: Parameters<typeof attachMessageMedia>) => attachMessageMedia(...args)
export const deleteMessageMediaV1 = (...args: Parameters<typeof deleteMessageMedia>) => deleteMessageMedia(...args)
export const receiveMessageV1 = (...args: Parameters<typeof receiveMessage>) => receiveMessage(...args)
export const sendMessageV1 = (...args: Parameters<typeof sendMessage>) => sendMessage(...args)
export const updateConversationV1 = (...args: Parameters<typeof updateConversation>) => updateConversation(...args)
export const deleteHistoryImportJobV1 = (...args: Parameters<typeof deleteHistoryImportJob>) => deleteHistoryImportJob(...args)
export const updateHistoryImportJobV1 = (...args: Parameters<typeof updateHistoryImportJob>) => updateHistoryImportJob(...args)
export const deleteHistoryImportJobsForConnectionV1 = (...args: Parameters<typeof deleteHistoryImportJobsForConnection>) => deleteHistoryImportJobsForConnection(...args)
export const patchHistoryImportJobV1 = (...args: Parameters<typeof patchHistoryImportJob>) => patchHistoryImportJob(...args)
export const deleteHistoryImportJobsForChannelV1 = (...args: Parameters<typeof deleteHistoryImportJobsForChannel>) => deleteHistoryImportJobsForChannel(...args)
export const queueHistoryImportJobV1 = (...args: Parameters<typeof queueHistoryImportJob>) => queueHistoryImportJob(...args)
export const cancelHistoryImportJobV1 = (...args: Parameters<typeof cancelHistoryImportJob>) => cancelHistoryImportJob(...args)
export const syncCallTimelineV1 = (...args: Parameters<typeof syncCallTimeline>) => syncCallTimeline(...args)
const messagingCompletedCallTimelineProjector = createCompletedCallTimelineMessagingProjectorV1({ sync: syncCallTimelineV1, broadcast: broadcastChatMessage })
export function messagingCompletedCallTimelineProjectorV1(...args: Parameters<typeof messagingCompletedCallTimelineProjector>) {
    return messagingCompletedCallTimelineProjector(...args)
}
export const createCommunicationTriggerV1 = (...args: Parameters<typeof createCommunicationTrigger>) => createCommunicationTrigger(...args)
export const updateCommunicationTriggerV1 = (...args: Parameters<typeof updateCommunicationTrigger>) => updateCommunicationTrigger(...args)
export const deleteCommunicationTriggerV1 = (...args: Parameters<typeof deleteCommunicationTrigger>) => deleteCommunicationTrigger(...args)
export const ensureLeadConversationV1 = (...args: Parameters<typeof ensureLeadConversation>) => ensureLeadConversation(...args)
export const resolveConversationV1 = (...args: Parameters<typeof resolveConversation>) => resolveConversation(...args)
export const claimMessageEventV1 = (...args: Parameters<typeof claimMessageEvent>) => claimMessageEvent(...args)
export const completeMessageEventV1 = (...args: Parameters<typeof completeMessageEvent>) => completeMessageEvent(...args)
export const failMessageEventV1 = (...args: Parameters<typeof failMessageEvent>) => failMessageEvent(...args)
export const deleteMessageV1 = (...args: Parameters<typeof deleteMessage>) => deleteMessage(...args)
export const replaceExternalMessageV1 = (...args: Parameters<typeof replaceExternalMessage>) => replaceExternalMessage(...args)
export const upsertExternalMessageV1 = (...args: Parameters<typeof upsertExternalMessage>) => upsertExternalMessage(...args)
export const patchExternalConversationV1 = (...args: Parameters<typeof patchExternalConversation>) => patchExternalConversation(...args)
export const createExternalConversationV1 = (...args: Parameters<typeof createExternalConversation>) => createExternalConversation(...args)
export const createChannelMessageV1 = (...args: Parameters<typeof createChannelMessage>) => createChannelMessage(...args)
export const patchMessageDeliveryV1 = (...args: Parameters<typeof patchMessageDelivery>) => patchMessageDelivery(...args)
export const upsertChannelConversationV1 = (...args: Parameters<typeof upsertChannelConversation>) => upsertChannelConversation(...args)
export const patchChannelConversationV1 = (...args: Parameters<typeof patchChannelConversation>) => patchChannelConversation(...args)
export const deleteRetainedMessagesV1 = (...args: Parameters<typeof deleteRetainedMessages>) => deleteRetainedMessages(...args)
export const purgeMessageRetryMetadataV1 = (...args: Parameters<typeof purgeMessageRetryMetadata>) => purgeMessageRetryMetadata(...args)
export const attachBinaryMessageMediaV1 = (...args: Parameters<typeof attachBinaryMessageMedia>) => attachBinaryMessageMedia(...args)
export const deliverQueuedMessagesForConnectionV1 = (...args: Parameters<typeof deliverQueuedMessagesForConnection>) => deliverQueuedMessagesForConnection(...args)
export const deleteQueuedMessagesForConnectionV1 = (...args: Parameters<typeof deleteQueuedMessagesForConnection>) => deleteQueuedMessagesForConnection(...args)
export const deleteLegacyExternalConversationsV1 = (...args: Parameters<typeof deleteLegacyExternalConversations>) => deleteLegacyExternalConversations(...args)
export const deleteConversationsByIdV1 = (...args: Parameters<typeof deleteConversationsById>) => deleteConversationsById(...args)
export const detachContactConversationsV1 = (...args: Parameters<typeof detachContactConversations>) => detachContactConversations(...args)
export const ensureConversationContactLinkV1 = (...args: Parameters<typeof ensureConversationContactLink>) => ensureConversationContactLink(...args)
export const findAndBackfillContactConversationV1 = (...args: Parameters<typeof findAndBackfillContactConversation>) => findAndBackfillContactConversation(...args)
export const openFallbackContactConversationV1 = (...args: Parameters<typeof openFallbackContactConversation>) => openFallbackContactConversation(...args)
export const patchMessageMetadataV1 = (...args: Parameters<typeof patchMessageMetadata>) => patchMessageMetadata(...args)
export const deleteConversationsByChannelV1 = (...args: Parameters<typeof deleteConversationsByChannel>) => deleteConversationsByChannel(...args)
export async function linkMatchedDriverToConversationCapabilityV1(input: { chatId: string, driverId: string }) {
    return linkMatchedDriverToConversationCommand({ contract: LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1, ...input })
}
