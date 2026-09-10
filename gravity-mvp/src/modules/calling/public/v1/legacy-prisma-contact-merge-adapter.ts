import type { Prisma } from '@prisma/client'
import type { AutomatedMergeRecoveryOwnerRepositoryV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'

/** Owner-scoped Call mutations used by the shared Contact merge transaction. */
export function makeCallingContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    recovery: makeCallingAutomatedMergeRecoveryRepositoryV1(transaction),
    async moveCallsToContact(sourceContactId: string, targetContactId: string) {
      await transaction.call.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId },
      })
    },
  }
}

export function makeCallingAutomatedMergeRecoveryRepositoryV1(
  transaction: Prisma.TransactionClient,
): AutomatedMergeRecoveryOwnerRepositoryV1 {
  return {
    async canRestore(plan) {
      const archivedContactCallCount = await transaction.call.count({
        where: { contactId: plan.mergedId },
      })
      if (archivedContactCallCount !== 0) return false
      if (plan.callIds.length === 0) return true
      return transaction.call.count({
        where: { id: { in: plan.callIds }, contactId: plan.survivorId },
      }).then(count => count === plan.callIds.length)
    },
    async restore(plan) {
      if (plan.callIds.length === 0) return
      const result = await transaction.call.updateMany({
        where: { id: { in: plan.callIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      if (result.count !== plan.callIds.length) throw new Error('CALLING_RECOVERY_STATE_CHANGED')
    },
  }
}
