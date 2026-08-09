import { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
import { legacyPrismaRecordKnowledgeUsagePortV1 } from './legacy-prisma-record-knowledge-usage-adapter'
import { createRecordAiDecisionHandlerV1 } from './record-ai-decision-handler'
import { legacyPrismaRecordAiDecisionPortV1 } from './legacy-prisma-record-ai-decision-adapter'
import { createReviewAiDecisionHandlerV1 } from './review-ai-decision-handler'
import { legacyPrismaReviewAiDecisionPortV1 } from './legacy-prisma-review-ai-decision-adapter'

export { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
export type { RecordKnowledgeUsagePersistencePortV1 } from './record-knowledge-usage-handler'
export const recordKnowledgeUsageV1 = createRecordKnowledgeUsageHandlerV1(legacyPrismaRecordKnowledgeUsagePortV1)
export { createRecordAiDecisionHandlerV1 } from './record-ai-decision-handler'
export type { RecordAiDecisionPersistencePortV1 } from './record-ai-decision-handler'
export const recordAiDecisionV1 = createRecordAiDecisionHandlerV1(legacyPrismaRecordAiDecisionPortV1)
export { createReviewAiDecisionHandlerV1 } from './review-ai-decision-handler'
export type { ReviewAiDecisionPersistencePortV1 } from './review-ai-decision-handler'
export const reviewAiDecisionV1 = createReviewAiDecisionHandlerV1(legacyPrismaReviewAiDecisionPortV1)
