import { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
import { legacyPrismaRecordKnowledgeUsagePortV1 } from './legacy-prisma-record-knowledge-usage-adapter'
import { createRecordAiDecisionHandlerV1 } from './record-ai-decision-handler'
import { legacyPrismaRecordAiDecisionPortV1 } from './legacy-prisma-record-ai-decision-adapter'
import { createReviewAiDecisionHandlerV1 } from './review-ai-decision-handler'
import { legacyPrismaReviewAiDecisionPortV1 } from './legacy-prisma-review-ai-decision-adapter'
import { createUpdateRetrievalPolicyHandlerV1 } from './update-retrieval-policy-handler'
import { legacyPrismaUpdateRetrievalPolicyPortV1 } from './legacy-prisma-update-retrieval-policy-adapter'

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
