import type { Prisma } from '@prisma/client'
import type { AutomatedMergeRecoveryOwnerRepositoryV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'

/**
 * Owner-controlled transactional capability used by contact merge workflows.
 * The surface intentionally exposes only the four chat relinking operations
 * required by the contact merge contract; callers cannot obtain a model or
 * unrestricted Prisma client from this adapter.
 */
export function makeMessagingContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
    recovery: makeMessagingAutomatedMergeRecoveryRepositoryV1(transaction),
    async remapChatsToIdentity(oldIdentityId: string, newIdentityId: string) {
      await transaction.chat.updateMany({
        where: { contactIdentityId: oldIdentityId },
        data: { contactIdentityId: newIdentityId },
      })
    },

    async moveChatsToContact(sourceContactId: string, targetContactId: string) {
      await transaction.chat.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId },
      })
    },

    async moveChatsToDriverContact(sourceContactId: string, targetContactId: string, driverId: string) {
      await transaction.chat.updateMany({
        where: { contactId: sourceContactId },
        data: { contactId: targetContactId, driverId },
      })
    },

    async attachUnlinkedContactChatsToDriver(contactId: string, driverId: string) {
      await transaction.chat.updateMany({
        where: { contactId, driverId: null },
        data: { driverId },
      })
    },
  }
}

export function makeMessagingAutomatedMergeRecoveryRepositoryV1(
  transaction: Prisma.TransactionClient,
): AutomatedMergeRecoveryOwnerRepositoryV1 {
  return {
    async canRestore(plan) {
      if (plan.chatIds.length === 0) return true
      return transaction.chat.count({
        where: { id: { in: plan.chatIds }, contactId: plan.survivorId },
      }).then(count => count === plan.chatIds.length)
    },
    async restore(plan) {
      if (plan.chatIds.length === 0) return
      const result = await transaction.chat.updateMany({
        where: { id: { in: plan.chatIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      if (result.count !== plan.chatIds.length) throw new Error('MESSAGING_RECOVERY_STATE_CHANGED')
    },
  }
}
