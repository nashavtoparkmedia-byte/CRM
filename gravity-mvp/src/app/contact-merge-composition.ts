import { prisma } from '@/lib/prisma'
import {
  createMergeContactsHandlerV1,
  type ContactMergeSimpleLinkRepositoriesV1,
  type ContactMergeTransactionalRepositoriesV1,
  type ContactMergeUnitOfWorkV1,
} from '@/modules/contacts/public/v1'
import {
  legacyPrismaContactMergeQueriesV1,
  makeLegacyPrismaContactMergeRepositoriesV1,
} from '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter'
import { makeMessagingContactMergeRepositories } from '@/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter'
import { makeWorkContactMergeRepositories } from '@/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter'

/**
 * Application composition for the one cross-owner contact merge transaction.
 * This is deliberately an exact, closed capability assembly: Contacts,
 * Messaging, and Work Management each bind only their named merge operations
 * to the transaction opened here.  No transaction escapes to a handler or
 * public command contract.
 */
function makeTransactionalRepositories(transaction: Parameters<typeof makeLegacyPrismaContactMergeRepositoriesV1>[0]): ContactMergeTransactionalRepositoriesV1 {
  return {
    ...makeLegacyPrismaContactMergeRepositoriesV1(transaction),
    messaging: makeMessagingContactMergeRepositories(transaction),
    work: makeWorkContactMergeRepositories(transaction),
  }
}

function makeSimpleLinkRepositories(
  repositories: ContactMergeTransactionalRepositoriesV1,
): ContactMergeSimpleLinkRepositoriesV1 {
  return {
    contacts: { linkContactToDriver: repositories.contacts.linkContactToDriver },
    messaging: {
      attachUnlinkedContactChatsToDriver: repositories.messaging.attachUnlinkedContactChatsToDriver,
    },
  }
}

const contactMergeUnitOfWorkV1: ContactMergeUnitOfWorkV1 = {
  async runSimpleLink(operation) {
    await prisma.$transaction(async (transaction) => {
      await operation(makeSimpleLinkRepositories(makeTransactionalRepositories(transaction)))
    })
  },

  async runMerge(operation) {
    await prisma.$transaction(async (transaction) => {
      await operation(makeTransactionalRepositories(transaction))
    }, { timeout: 15000 })
  },
}

export const mergeContactsV1 = createMergeContactsHandlerV1({
  queries: legacyPrismaContactMergeQueriesV1,
  unitOfWork: contactMergeUnitOfWorkV1,
})
