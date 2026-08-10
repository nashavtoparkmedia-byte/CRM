import { prisma } from '@/lib/prisma'
import type { ContactConversationRetentionPersistencePortV1 } from './contact-retention-handler'

export const legacyPrismaContactConversationRetentionPortV1: ContactConversationRetentionPersistencePortV1 = {
  async detachContactConversations(contactId) {
    await prisma.$executeRawUnsafe(
      'UPDATE "Chat" SET "contactId" = NULL, "contactIdentityId" = NULL WHERE "contactId" = $1',
      contactId,
    )
  },
}
