import{prisma}from'@/lib/prisma';import type{KnowledgeSourcePersistencePortV1}from'./knowledge-source-handler'
export const legacyPrismaKnowledgeSourcePortV1:KnowledgeSourcePersistencePortV1={async attachManual(input){const excerptHash='manual:'+input.itemId;await prisma.$executeRaw`
    INSERT INTO "AiKnowledgeSource" (id,"itemId","originType","messageId","chatId",channel,"managerUserId",excerpt,"excerptHash",confidence,"occurredAt","createdAt")
    VALUES (${input.sourceId},${input.itemId},'manual_entry',NULL,NULL,NULL,${input.actorId},'[создано вручную администратором]',${excerptHash},1.0,NOW(),NOW())
`},async disable(input){const count=await prisma.$executeRaw`
    UPDATE "AiKnowledgeSource" SET "isActive"=false
    WHERE channel::text=${input.channel} AND "connectionId"=${input.connectionId} AND "isActive"=true
`;return{disabledCount:Number(count)}}}
