import { prisma } from '@/lib/prisma'
import type { RecordAiDecisionPersistencePortV1 } from './record-ai-decision-handler'

export const legacyPrismaRecordAiDecisionPortV1: RecordAiDecisionPersistencePortV1 = {
  async append(input) {
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiDecisionLog" (id, "messageId", "chatId", channel, "detectedIntent", confidence, decision, "selectedModel", "usedKnowledgeEntries", "generatedReply", "replySent", escalated, error, "retrievalMode", "retrievalDecision", "escalationReason", "knowledgeRuntimeVersion", "shadowRetrievalSummary", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW())',
      input.id,
      input.messageId,
      input.chatId,
      input.channel,
      input.detectedIntent,
      input.confidence,
      input.decision,
      input.selectedModel,
      input.usedKnowledgeEntriesJson,
      input.generatedReply,
      input.replySent,
      input.escalated,
      input.error,
      input.retrievalMode,
      input.retrievalDecision,
      input.escalationReason,
      input.knowledgeRuntimeVersion,
      input.shadowRetrievalSummaryJson,
    )
  },
}
