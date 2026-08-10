import { prisma } from '@/lib/prisma'
import type { KnowledgeSourcePersistencePortV1 } from './knowledge-source-handler'

export const legacyPrismaKnowledgeSourcePortV1: KnowledgeSourcePersistencePortV1 = {
  async attachManual(input) {
    const excerptHash = `manual:${input.itemId}`
    await prisma.$executeRawUnsafe(
      'INSERT INTO "AiKnowledgeSource" (id,"itemId","originType","messageId","chatId",channel,"managerUserId",excerpt,"excerptHash",confidence,"occurredAt","createdAt") VALUES ($1,$2,\'manual_entry\',NULL,NULL,NULL,$3,\'[создано вручную администратором]\',$4,1.0,NOW(),NOW())',
      input.sourceId,
      input.itemId,
      input.actorId,
      excerptHash,
    )
  },

  async disable(input) {
    const count = await prisma.$executeRawUnsafe(
      'UPDATE "AiKnowledgeSource" SET "isActive"=false WHERE channel::text=$1 AND "connectionId"=$2 AND "isActive"=true',
      input.channel,
      input.connectionId,
    )
    return { disabledCount: Number(count) }
  },
}
