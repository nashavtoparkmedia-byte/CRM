import { prisma } from '@/lib/prisma'
import type { MessageRetentionPersistencePortV1 } from './message-retention-handler'

export const legacyPrismaMessageRetentionPortV1: MessageRetentionPersistencePortV1 = {
  async deleteMessages(messageIds) {
    await prisma.$executeRawUnsafe(
      'DELETE FROM "Message" WHERE id = ANY($1::text[])',
      messageIds,
    )
  },

  async purgeRetryMetadata(messageIds) {
    await prisma.$executeRawUnsafe(
      'UPDATE "Message" SET metadata = jsonb_build_object(\'error\', metadata->>\'error\', \'cleaned\', true) WHERE id = ANY($1::text[])',
      messageIds,
    )
  },
}
