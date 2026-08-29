import { prisma } from '@/lib/prisma'
import type { KnowledgeItemReviewPersistencePortV1 } from './knowledge-item-review-handler'

export const legacyPrismaKnowledgeItemReviewPortV1: KnowledgeItemReviewPersistencePortV1 = {
  async verify(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "isVerified"=true,"verifiedBy"=$1,"verifiedAt"=NOW(),status=\'active\'::"AiKnowledgeStatus","isActive"=true,"updatedAt"=NOW() WHERE id=$2',
      input.verifiedBy,
      input.itemId,
    )
  },

  async applyCoachEdit(input) {
    await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeItem" SET "canonicalStatement"=$1,"updatedAt"=NOW(),"isVerified"=true,"verifiedBy"=$2,"verifiedAt"=NOW(),status=\'active\'::"AiKnowledgeStatus","isActive"=true WHERE id=$3',
      input.canonicalStatement,
      input.verifiedBy,
      input.itemId,
    )
  },
}
