import { createAttachMessageMediaHandlerV1 } from './attach-message-media-handler'
import { legacyPrismaAttachMessageMediaPortV1 } from './legacy-prisma-attach-message-media-adapter'
import { createDeleteMessageMediaHandlerV1 } from './delete-message-media-handler'
import { legacyPrismaDeleteMessageMediaPortV1 } from './legacy-prisma-delete-message-media-adapter'
import { createReceiveMessageHandlerV1 } from './receive-message-handler'
import { legacyPrismaReceiveMessagePortV1 } from './legacy-prisma-receive-message-adapter'
import { createSendMessageHandlerV1 } from './send-message-handler'
import { legacyPrismaSendMessagePortV1 } from './legacy-prisma-send-message-adapter'
import { createUpdateConversationHandlerV1 } from './update-conversation-handler'
import { legacyPrismaUpdateConversationPortV1 } from './legacy-prisma-update-conversation-adapter'
import { createCancelHistoryImportJobHandlerV1,createDeleteHistoryImportJobsForChannelHandlerV1,createDeleteHistoryImportJobsForConnectionHandlerV1,createDeleteHistoryImportJobHandlerV1,createPatchHistoryImportJobHandlerV1,createQueueHistoryImportJobHandlerV1,createUpdateHistoryImportJobHandlerV1 } from './history-import-job-handler'
import { legacyPrismaHistoryImportJobPortV1 } from './legacy-prisma-history-import-job-adapter'
import { createSyncCallTimelineHandlerV1 } from './sync-call-timeline-handler'
import { legacyPrismaSyncCallTimelinePortV1 } from './legacy-prisma-sync-call-timeline-adapter'
import { createCreateCommunicationTriggerHandlerV1,createDeleteCommunicationTriggerHandlerV1,createUpdateCommunicationTriggerHandlerV1 } from './communication-trigger-handler'
import { legacyPrismaCommunicationTriggerPortV1 } from './legacy-prisma-communication-trigger-adapter'
import { createEnsureLeadConversationHandlerV1,createResolveConversationHandlerV1 } from './lead-conversation-handler'
import { legacyPrismaLeadConversationPortV1 } from './legacy-prisma-lead-conversation-adapter'
import { createClaimMessageEventHandlerV1,createCompleteMessageEventHandlerV1,createFailMessageEventHandlerV1 } from './message-event-log-handler'
import { legacyPrismaMessageEventLogPortV1 } from './legacy-prisma-message-event-log-adapter'
import { createDeleteMessageHandlerV1,createReplaceExternalMessageHandlerV1,createUpsertExternalMessageHandlerV1 } from './external-message-handler'
import { legacyPrismaExternalMessagePortV1 } from './legacy-prisma-external-message-adapter'
import { createCreateExternalConversationHandlerV1,createPatchExternalConversationHandlerV1 } from './external-conversation-handler'
import { legacyPrismaExternalConversationPortV1 } from './legacy-prisma-external-conversation-adapter'
import { createCreateChannelMessageHandlerV1,createPatchMessageDeliveryHandlerV1 } from './channel-message-handler'
import { legacyPrismaChannelMessagePortV1 } from './legacy-prisma-channel-message-adapter'
import { createPatchChannelConversationHandlerV1,createUpsertChannelConversationHandlerV1 } from './channel-conversation-handler'
import { legacyPrismaChannelConversationPortV1 } from './legacy-prisma-channel-conversation-adapter'
import { createDeleteRetainedMessagesHandlerV1,createPurgeMessageRetryMetadataHandlerV1 } from './message-retention-handler'
import { legacyPrismaMessageRetentionPortV1 } from './legacy-prisma-message-retention-adapter'
import { createAttachBinaryMessageMediaHandlerV1 } from './attach-binary-message-media-handler'
import { legacyPrismaAttachBinaryMessageMediaPortV1 } from './legacy-prisma-attach-binary-message-media-adapter'
import { createDeleteConversationsByIdHandlerV1,createDeleteLegacyExternalConversationsHandlerV1,createDeleteQueuedMessagesForConnectionHandlerV1,createDeliverQueuedMessagesForConnectionHandlerV1 } from './channel-maintenance-handler'
import { legacyPrismaChannelMaintenancePortV1 } from './legacy-prisma-channel-maintenance-adapter'
import { createRunCommunicationEventRetentionHandlerV1 } from './communication-event-retention-handler'
import { legacyPrismaCommunicationEventRetentionPortV1 } from './legacy-prisma-communication-event-retention-adapter'
import { createDetachContactConversationsHandlerV1 } from './contact-retention-handler'
import { legacyPrismaContactConversationRetentionPortV1 } from './legacy-prisma-contact-retention-adapter'
import { createEnsureConversationContactLinkHandlerV1 } from './conversation-contact-link-handler'
import { legacyPrismaConversationContactLinkPortV1 } from './legacy-prisma-conversation-contact-link-adapter'
import { createFindAndBackfillContactConversationHandlerV1, createOpenFallbackContactConversationHandlerV1 } from './contact-conversation-handler'
import { legacyPrismaContactConversationPortV1 } from './legacy-prisma-contact-conversation-adapter'
import { createRecordManagerDriverCommunicationHandlerV1 } from './record-manager-driver-communication-handler'
import { legacyPrismaRecordManagerDriverCommunicationPortV1 } from './legacy-prisma-record-manager-driver-communication-adapter'

export { createAttachMessageMediaHandlerV1 } from './attach-message-media-handler'
export type { AttachMessageMediaPersistencePortV1 } from './attach-message-media-handler'
export const attachMessageMediaV1 = createAttachMessageMediaHandlerV1(legacyPrismaAttachMessageMediaPortV1)
export { createDeleteMessageMediaHandlerV1 } from './delete-message-media-handler'
export type { DeleteMessageMediaPersistencePortV1 } from './delete-message-media-handler'
export const deleteMessageMediaV1 = createDeleteMessageMediaHandlerV1(legacyPrismaDeleteMessageMediaPortV1)
export { createReceiveMessageHandlerV1 } from './receive-message-handler'
export type { ReceiveMessagePersistencePortV1 } from './receive-message-handler'
export const receiveMessageV1 = createReceiveMessageHandlerV1(legacyPrismaReceiveMessagePortV1)
export { createSendMessageHandlerV1 } from './send-message-handler'
export type { SendMessagePersistencePortV1 } from './send-message-handler'
export const sendMessageV1 = createSendMessageHandlerV1(legacyPrismaSendMessagePortV1)
export { createUpdateConversationHandlerV1 } from './update-conversation-handler'
export type { UpdateConversationPersistencePortV1 } from './update-conversation-handler'
export const updateConversationV1 = createUpdateConversationHandlerV1(legacyPrismaUpdateConversationPortV1)
export { createDeleteHistoryImportJobHandlerV1,createUpdateHistoryImportJobHandlerV1 } from './history-import-job-handler'
export type { HistoryImportJobPersistencePortV1 } from './history-import-job-handler'
export const deleteHistoryImportJobV1=createDeleteHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
export const updateHistoryImportJobV1=createUpdateHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
export { createDeleteHistoryImportJobsForConnectionHandlerV1,createPatchHistoryImportJobHandlerV1 } from './history-import-job-handler'
export const deleteHistoryImportJobsForConnectionV1=createDeleteHistoryImportJobsForConnectionHandlerV1(legacyPrismaHistoryImportJobPortV1)
export const patchHistoryImportJobV1=createPatchHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
export { createDeleteHistoryImportJobsForChannelHandlerV1 } from './history-import-job-handler'
export const deleteHistoryImportJobsForChannelV1=createDeleteHistoryImportJobsForChannelHandlerV1(legacyPrismaHistoryImportJobPortV1)
export { createCancelHistoryImportJobHandlerV1,createQueueHistoryImportJobHandlerV1 } from './history-import-job-handler'
export const queueHistoryImportJobV1=createQueueHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
export const cancelHistoryImportJobV1=createCancelHistoryImportJobHandlerV1(legacyPrismaHistoryImportJobPortV1)
export { createSyncCallTimelineHandlerV1 } from './sync-call-timeline-handler'
export type { SyncCallTimelinePersistencePortV1,SyncCallTimelinePersistenceResultV1 } from './sync-call-timeline-handler'
export const syncCallTimelineV1=createSyncCallTimelineHandlerV1(legacyPrismaSyncCallTimelinePortV1)
export { createCreateCommunicationTriggerHandlerV1,createDeleteCommunicationTriggerHandlerV1,createUpdateCommunicationTriggerHandlerV1 } from './communication-trigger-handler'
export type { CommunicationTriggerPersistencePortV1 } from './communication-trigger-handler'
export const createCommunicationTriggerV1=createCreateCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
export const updateCommunicationTriggerV1=createUpdateCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
export const deleteCommunicationTriggerV1=createDeleteCommunicationTriggerHandlerV1(legacyPrismaCommunicationTriggerPortV1)
export { createEnsureLeadConversationHandlerV1,createResolveConversationHandlerV1 } from './lead-conversation-handler'
export type { LeadConversationPersistencePortV1 } from './lead-conversation-handler'
export const ensureLeadConversationV1=createEnsureLeadConversationHandlerV1(legacyPrismaLeadConversationPortV1)
export const resolveConversationV1=createResolveConversationHandlerV1(legacyPrismaLeadConversationPortV1)
export { createClaimMessageEventHandlerV1,createCompleteMessageEventHandlerV1,createFailMessageEventHandlerV1 } from './message-event-log-handler'
export type { MessageEventLogPersistencePortV1 } from './message-event-log-handler'
export const claimMessageEventV1=createClaimMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
export const completeMessageEventV1=createCompleteMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
export const failMessageEventV1=createFailMessageEventHandlerV1(legacyPrismaMessageEventLogPortV1)
export { createDeleteMessageHandlerV1,createReplaceExternalMessageHandlerV1,createUpsertExternalMessageHandlerV1 } from './external-message-handler'
export type { ExternalMessagePersistencePortV1 } from './external-message-handler'
export const deleteMessageV1=createDeleteMessageHandlerV1(legacyPrismaExternalMessagePortV1)
export const replaceExternalMessageV1=createReplaceExternalMessageHandlerV1(legacyPrismaExternalMessagePortV1)
export const upsertExternalMessageV1=createUpsertExternalMessageHandlerV1(legacyPrismaExternalMessagePortV1)
export { createCreateExternalConversationHandlerV1,createPatchExternalConversationHandlerV1 } from './external-conversation-handler'
export type { ExternalConversationPersistencePortV1 } from './external-conversation-handler'
export const patchExternalConversationV1=createPatchExternalConversationHandlerV1(legacyPrismaExternalConversationPortV1)
export const createExternalConversationV1=createCreateExternalConversationHandlerV1(legacyPrismaExternalConversationPortV1)
export { createCreateChannelMessageHandlerV1,createPatchMessageDeliveryHandlerV1 } from './channel-message-handler'
export type { ChannelMessagePersistencePortV1 } from './channel-message-handler'
export const createChannelMessageV1=createCreateChannelMessageHandlerV1(legacyPrismaChannelMessagePortV1)
export const patchMessageDeliveryV1=createPatchMessageDeliveryHandlerV1(legacyPrismaChannelMessagePortV1)
export { createPatchChannelConversationHandlerV1,createUpsertChannelConversationHandlerV1 } from './channel-conversation-handler'
export type { ChannelConversationPersistencePortV1 } from './channel-conversation-handler'
export const upsertChannelConversationV1=createUpsertChannelConversationHandlerV1(legacyPrismaChannelConversationPortV1)
export const patchChannelConversationV1=createPatchChannelConversationHandlerV1(legacyPrismaChannelConversationPortV1)
export { createDeleteRetainedMessagesHandlerV1,createPurgeMessageRetryMetadataHandlerV1 } from './message-retention-handler'
export type { MessageRetentionPersistencePortV1 } from './message-retention-handler'
export const deleteRetainedMessagesV1=createDeleteRetainedMessagesHandlerV1(legacyPrismaMessageRetentionPortV1)
export const purgeMessageRetryMetadataV1=createPurgeMessageRetryMetadataHandlerV1(legacyPrismaMessageRetentionPortV1)
export { createAttachBinaryMessageMediaHandlerV1 } from './attach-binary-message-media-handler'
export type { AttachBinaryMessageMediaPersistencePortV1 } from './attach-binary-message-media-handler'
export const attachBinaryMessageMediaV1=createAttachBinaryMessageMediaHandlerV1(legacyPrismaAttachBinaryMessageMediaPortV1)
export { createDeleteConversationsByIdHandlerV1,createDeleteLegacyExternalConversationsHandlerV1,createDeleteQueuedMessagesForConnectionHandlerV1,createDeliverQueuedMessagesForConnectionHandlerV1 } from './channel-maintenance-handler'
export type { ChannelMaintenancePersistencePortV1 } from './channel-maintenance-handler'
export const deliverQueuedMessagesForConnectionV1=createDeliverQueuedMessagesForConnectionHandlerV1(legacyPrismaChannelMaintenancePortV1)
export const deleteQueuedMessagesForConnectionV1=createDeleteQueuedMessagesForConnectionHandlerV1(legacyPrismaChannelMaintenancePortV1)
export const deleteLegacyExternalConversationsV1=createDeleteLegacyExternalConversationsHandlerV1(legacyPrismaChannelMaintenancePortV1)
export const deleteConversationsByIdV1=createDeleteConversationsByIdHandlerV1(legacyPrismaChannelMaintenancePortV1)
export { createRunCommunicationEventRetentionHandlerV1 } from './communication-event-retention-handler'
export type { CommunicationEventRetentionPersistencePortV1 } from './communication-event-retention-handler'
export const runCommunicationEventRetentionV1=createRunCommunicationEventRetentionHandlerV1(legacyPrismaCommunicationEventRetentionPortV1)
export { createDetachContactConversationsHandlerV1 } from './contact-retention-handler'
export type { ContactConversationRetentionPersistencePortV1 } from './contact-retention-handler'
export const detachContactConversationsV1=createDetachContactConversationsHandlerV1(legacyPrismaContactConversationRetentionPortV1)
export { createEnsureConversationContactLinkHandlerV1 } from './conversation-contact-link-handler'
export type { ConversationContactLinkPersistencePortV1 } from './conversation-contact-link-handler'
export const ensureConversationContactLinkV1=createEnsureConversationContactLinkHandlerV1(legacyPrismaConversationContactLinkPortV1)
export { createFindAndBackfillContactConversationHandlerV1, createOpenFallbackContactConversationHandlerV1 } from './contact-conversation-handler'
export type { ContactConversationPersistencePortV1 } from './contact-conversation-handler'
export const findAndBackfillContactConversationV1=createFindAndBackfillContactConversationHandlerV1(legacyPrismaContactConversationPortV1)
export const openFallbackContactConversationV1=createOpenFallbackContactConversationHandlerV1(legacyPrismaContactConversationPortV1)
export { createRecordManagerDriverCommunicationHandlerV1 } from './record-manager-driver-communication-handler'
export type { RecordManagerDriverCommunicationPersistencePortV1 } from './record-manager-driver-communication-handler'
export const recordManagerDriverCommunicationV1 = createRecordManagerDriverCommunicationHandlerV1(
    legacyPrismaRecordManagerDriverCommunicationPortV1,
)
