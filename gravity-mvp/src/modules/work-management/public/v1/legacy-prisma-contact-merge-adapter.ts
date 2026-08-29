import type { Prisma } from '@prisma/client'

/**
 * Owner-controlled transactional capability for the one work-management
 * mutation needed during contact merge. No generic model access is exposed.
 */
export function makeWorkContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    async moveTasksToContact(sourceContactId: string, targetContactId: string) {
      await transaction.task.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId },
      })
    },
  }
}
