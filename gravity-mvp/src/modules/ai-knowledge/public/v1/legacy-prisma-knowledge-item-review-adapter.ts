import{prisma}from'@/lib/prisma';import type{KnowledgeItemReviewPersistencePortV1}from'./knowledge-item-review-handler'
export const legacyPrismaKnowledgeItemReviewPortV1:KnowledgeItemReviewPersistencePortV1={async verify(input){await prisma.$executeRaw`
    UPDATE "AiKnowledgeItem" SET "isVerified"=true,"verifiedBy"=${input.verifiedBy},"verifiedAt"=NOW(),status='active'::"AiKnowledgeStatus","isActive"=true,"updatedAt"=NOW() WHERE id=${input.itemId}
`},async applyCoachEdit(input){await prisma.$executeRaw`
    UPDATE "AiKnowledgeItem" SET "canonicalStatement"=${input.canonicalStatement},"updatedAt"=NOW(),"isVerified"=true,"verifiedBy"=${input.verifiedBy},"verifiedAt"=NOW(),status='active'::"AiKnowledgeStatus","isActive"=true WHERE id=${input.itemId}
`}}
