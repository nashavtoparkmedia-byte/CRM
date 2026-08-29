import { prisma } from '@/lib/prisma'
import type { ReviewAiDecisionPersistencePortV1 } from './review-ai-decision-handler'

export const legacyPrismaReviewAiDecisionPortV1: ReviewAiDecisionPersistencePortV1 = {
  async review(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiDecisionLog" SET "reviewedByOperator" = true, "operatorVerdict" = $1 WHERE id = $2',
      input.verdict,
      input.logId,
    )
  },
}
