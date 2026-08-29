import { prisma } from '@/lib/prisma'
import type { RecordKnowledgeUsagePersistencePortV1 } from './record-knowledge-usage-handler'

export const legacyPrismaRecordKnowledgeUsagePortV1: RecordKnowledgeUsagePersistencePortV1 = {
  async append(input) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiKnowledgeUsageLog" (id, "itemId", "runtimeContext", "decisionLogId", "messageId", "retrievalScore", "rerankScore", "usedInReply", "policyDecision", "shadowMode", "escalationReason", "usedAt") VALUES ($1, $2, \'chat_reply\'::"AiKnowledgeRuntime", $3, $4, $5, $6, $7, $8, $9, $10, NOW())',
      input.id,
      input.itemId,
      input.decisionLogId,
      input.messageId,
      input.retrievalScore,
      input.rerankScore,
      input.usedInReply,
      input.policyDecision,
      input.shadowMode,
      input.escalationReason,
    )
  },
}
