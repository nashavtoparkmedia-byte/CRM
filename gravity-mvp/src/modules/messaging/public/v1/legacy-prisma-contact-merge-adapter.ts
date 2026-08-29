import type { Prisma } from '@prisma/client'

/**
 * Owner-controlled transactional capability used by contact merge workflows.
 * The surface intentionally exposes only the four chat relinking operations
 * required by the contact merge contract; callers cannot obtain a model or
 * unrestricted Prisma client from this adapter.
 */
export function makeMessagingContactMergeRepositories(transaction: Prisma.TransactionClient) {
  return {
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
