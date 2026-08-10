import { prisma } from '@/lib/prisma'
import type { QueueKnowledgeExtractionPersistencePortV1 } from './queue-knowledge-extraction-handler'

export const legacyPrismaQueueKnowledgeExtractionPortV1: QueueKnowledgeExtractionPersistencePortV1 = {
  async enqueue(input) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiExtractionJob" (id,status,"sourceType",scope,"extractionQualityTier","createdAt") VALUES ($1,\'queued\'::"AiExtractionStatus",\'chat_message\'::"AiKnowledgeSourceOrigin",$2::jsonb,$3,NOW())',
      input.jobId,
      input.scopeJson,
      input.qualityTier,
    )
  },
}
