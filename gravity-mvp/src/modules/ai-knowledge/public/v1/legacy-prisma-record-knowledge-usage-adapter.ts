import { prisma } from '@/lib/prisma'
import type { RecordKnowledgeUsagePersistencePortV1 } from './record-knowledge-usage-handler'

export const legacyPrismaRecordKnowledgeUsagePortV1: RecordKnowledgeUsagePersistencePortV1 = {
    async append(input) {
        await prisma.$executeRaw`
            INSERT INTO "AiKnowledgeUsageLog" (
                id, "itemId", "runtimeContext", "decisionLogId", "messageId",
                "retrievalScore", "rerankScore", "usedInReply",
                "policyDecision", "shadowMode", "escalationReason",
                "usedAt"
            ) VALUES (
                ${input.id},
                ${input.itemId},
                'chat_reply'::"AiKnowledgeRuntime",
                ${input.decisionLogId},
                ${input.messageId},
                ${input.retrievalScore},
                ${input.rerankScore},
                ${input.usedInReply},
                ${input.policyDecision},
                ${input.shadowMode},
                ${input.escalationReason},
                NOW()
            )
        `
    },
}
