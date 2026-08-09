import { prisma } from '@/lib/prisma'
import type { QueueKnowledgeExtractionPersistencePortV1 } from './queue-knowledge-extraction-handler'
export const legacyPrismaQueueKnowledgeExtractionPortV1:QueueKnowledgeExtractionPersistencePortV1={async enqueue(input){await prisma.$executeRaw`
    INSERT INTO "AiExtractionJob" (id,status,"sourceType",scope,"extractionQualityTier","createdAt")
    VALUES (${input.jobId},'queued'::"AiExtractionStatus",'chat_message'::"AiKnowledgeSourceOrigin",${input.scopeJson}::jsonb,${input.qualityTier},NOW())
`}}
