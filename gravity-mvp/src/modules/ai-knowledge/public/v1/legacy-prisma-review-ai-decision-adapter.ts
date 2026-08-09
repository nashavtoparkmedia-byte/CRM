import { prisma } from '@/lib/prisma'
import type { ReviewAiDecisionPersistencePortV1 } from './review-ai-decision-handler'
export const legacyPrismaReviewAiDecisionPortV1: ReviewAiDecisionPersistencePortV1 = {
    async review(input) {
        await prisma.$executeRaw`
            UPDATE "AiDecisionLog"
            SET "reviewedByOperator" = true, "operatorVerdict" = ${input.verdict}
            WHERE id = ${input.logId}
        `
    },
}
