import { prisma } from '@/lib/prisma'
import type { ContactTaskRetentionPersistencePortV1 } from './contact-retention-handler'

export const legacyPrismaContactTaskRetentionPortV1: ContactTaskRetentionPersistencePortV1 = {
  async detachContactTasks(contactId) {
    await prisma.$executeRawUnsafe(
      'UPDATE "tasks" SET "contactId" = NULL WHERE "contactId" = $1',
      contactId,
    )
  },
}
