import { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
import { legacyPrismaRecordKnowledgeUsagePortV1 } from './legacy-prisma-record-knowledge-usage-adapter'
import { createRecordAiDecisionHandlerV1 } from './record-ai-decision-handler'
import { legacyPrismaRecordAiDecisionPortV1 } from './legacy-prisma-record-ai-decision-adapter'
import { createReviewAiDecisionHandlerV1 } from './review-ai-decision-handler'
import { legacyPrismaReviewAiDecisionPortV1 } from './legacy-prisma-review-ai-decision-adapter'
import { createUpdateRetrievalPolicyHandlerV1 } from './update-retrieval-policy-handler'
import { legacyPrismaUpdateRetrievalPolicyPortV1 } from './legacy-prisma-update-retrieval-policy-adapter'
import { createQueueKnowledgeExtractionHandlerV1 } from './queue-knowledge-extraction-handler'
import { legacyPrismaQueueKnowledgeExtractionPortV1 } from './legacy-prisma-queue-knowledge-extraction-adapter'
import { createAttachManualKnowledgeSourceHandlerV1,createDisableKnowledgeSourcesHandlerV1 } from './knowledge-source-handler'
import { legacyPrismaKnowledgeSourcePortV1 } from './legacy-prisma-knowledge-source-adapter'
import { createApplyKnowledgeItemCoachEditHandlerV1,createVerifyKnowledgeItemHandlerV1 } from './knowledge-item-review-handler'
import { legacyPrismaKnowledgeItemReviewPortV1 } from './legacy-prisma-knowledge-item-review-adapter'
import { createPatchProposedReplyHandlerV1,createUpsertProposedReplyHandlerV1 } from './proposed-reply-handler'
import { legacyPrismaProposedReplyPortV1 } from './legacy-prisma-proposed-reply-adapter'

export { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
export type { RecordKnowledgeUsagePersistencePortV1 } from './record-knowledge-usage-handler'
export const recordKnowledgeUsageV1 = createRecordKnowledgeUsageHandlerV1(legacyPrismaRecordKnowledgeUsagePortV1)
export { createRecordAiDecisionHandlerV1 } from './record-ai-decision-handler'
export type { RecordAiDecisionPersistencePortV1 } from './record-ai-decision-handler'
export const recordAiDecisionV1 = createRecordAiDecisionHandlerV1(legacyPrismaRecordAiDecisionPortV1)
export { createReviewAiDecisionHandlerV1 } from './review-ai-decision-handler'
export type { ReviewAiDecisionPersistencePortV1 } from './review-ai-decision-handler'
export const reviewAiDecisionV1 = createReviewAiDecisionHandlerV1(legacyPrismaReviewAiDecisionPortV1)
export { createUpdateRetrievalPolicyHandlerV1 } from './update-retrieval-policy-handler'
export type { UpdateRetrievalPolicyPersistencePortV1 } from './update-retrieval-policy-handler'
export const updateRetrievalPolicyV1 = createUpdateRetrievalPolicyHandlerV1(legacyPrismaUpdateRetrievalPolicyPortV1)
export { createQueueKnowledgeExtractionHandlerV1 } from './queue-knowledge-extraction-handler'
export type { QueueKnowledgeExtractionPersistencePortV1 } from './queue-knowledge-extraction-handler'
export const queueKnowledgeExtractionV1=createQueueKnowledgeExtractionHandlerV1(legacyPrismaQueueKnowledgeExtractionPortV1)
export { createAttachManualKnowledgeSourceHandlerV1,createDisableKnowledgeSourcesHandlerV1 } from './knowledge-source-handler'
export type { KnowledgeSourcePersistencePortV1 } from './knowledge-source-handler'
export const attachManualKnowledgeSourceV1=createAttachManualKnowledgeSourceHandlerV1(legacyPrismaKnowledgeSourcePortV1)
export const disableKnowledgeSourcesV1=createDisableKnowledgeSourcesHandlerV1(legacyPrismaKnowledgeSourcePortV1)
export { createApplyKnowledgeItemCoachEditHandlerV1,createVerifyKnowledgeItemHandlerV1 } from './knowledge-item-review-handler'
export type { KnowledgeItemReviewPersistencePortV1 } from './knowledge-item-review-handler'
export const verifyKnowledgeItemV1=createVerifyKnowledgeItemHandlerV1(legacyPrismaKnowledgeItemReviewPortV1)
export const applyKnowledgeItemCoachEditV1=createApplyKnowledgeItemCoachEditHandlerV1(legacyPrismaKnowledgeItemReviewPortV1)
export { createPatchProposedReplyHandlerV1,createUpsertProposedReplyHandlerV1 } from './proposed-reply-handler'
export type { ProposedReplyPersistencePortV1 } from './proposed-reply-handler'
export const upsertProposedReplyV1=createUpsertProposedReplyHandlerV1(legacyPrismaProposedReplyPortV1)
export const patchProposedReplyV1=createPatchProposedReplyHandlerV1(legacyPrismaProposedReplyPortV1)
