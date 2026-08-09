import { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
import { legacyPrismaRecordKnowledgeUsagePortV1 } from './legacy-prisma-record-knowledge-usage-adapter'

export { createRecordKnowledgeUsageHandlerV1 } from './record-knowledge-usage-handler'
export type { RecordKnowledgeUsagePersistencePortV1 } from './record-knowledge-usage-handler'
export const recordKnowledgeUsageV1 = createRecordKnowledgeUsageHandlerV1(legacyPrismaRecordKnowledgeUsagePortV1)
