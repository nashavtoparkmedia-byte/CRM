import type { Prisma } from '@prisma/client'
import type { AutomatedMergeRecoveryOwnerRepositoryV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'

/**
 * Owner-controlled transactional capability for the one work-management
 * mutation needed during contact merge. No generic model access is exposed.
 */
export function makeWorkContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    recovery: makeWorkAutomatedMergeRecoveryRepositoryV1(transaction),
    async moveTasksToContact(sourceContactId: string, targetContactId: string) {
      await transaction.task.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId },
      })
    },
  }
}

export function makeWorkAutomatedMergeRecoveryRepositoryV1(
  transaction: Prisma.TransactionClient,
): AutomatedMergeRecoveryOwnerRepositoryV1 {
  return {
    async canRestore(plan) {
      if (plan.taskIds.length === 0) return true
      return transaction.task.count({
        where: { id: { in: plan.taskIds }, contactId: plan.survivorId },
      }).then(count => count === plan.taskIds.length)
    },
    async restore(plan) {
      if (plan.taskIds.length === 0) return
      const result = await transaction.task.updateMany({
        where: { id: { in: plan.taskIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      if (result.count !== plan.taskIds.length) throw new Error('WORK_RECOVERY_STATE_CHANGED')
    },
  }
}
