import { prisma } from '@/lib/prisma'
import {
  createMergeContactsHandlerV1,
  type ContactMergeTransactionalRepositoriesV1,
  type ContactMergeUnitOfWorkV1,
  type AutomatedMergeRecoveryRepositoriesV1,
  type AutomatedMergeRecoveryUnitOfWorkV1,
} from '@/modules/contacts/public/v1'
import {
  makeLegacyPrismaContactMergeRepositoriesV1,
} from '@/modules/contacts/public/v1/legacy-prisma-contact-merge-adapter'
import { makeMessagingContactMergeRepositories } from '@/modules/messaging/public/v1/legacy-prisma-contact-merge-adapter'
import { makeWorkContactMergeRepositories } from '@/modules/work-management/public/v1/legacy-prisma-contact-merge-adapter'

/**
 * Shared-infrastructure composition for the one cross-owner contact merge
 * transaction. Contacts, Messaging, and Work Management bind only their
 * named merge operations to this boundary; no transaction escapes to a
 * handler or public command contract.
 */
function makeTransactionalRepositories(transaction: Parameters<typeof makeLegacyPrismaContactMergeRepositoriesV1>[0]): ContactMergeTransactionalRepositoriesV1 {
  const contacts = makeLegacyPrismaContactMergeRepositoriesV1(transaction)
  const messaging = makeMessagingContactMergeRepositories(transaction)
  const work = makeWorkContactMergeRepositories(transaction)
  return {
    contacts: contacts.contacts,
    fleet: contacts.fleet,
    messaging,
    work,
  }
}

const contactMergeUnitOfWorkV1: ContactMergeUnitOfWorkV1 = {
  async run(operation) {
    return prisma.$transaction(async transaction => {
      return operation(makeTransactionalRepositories(transaction))
    }, {
      // Admission serializes ownership work; READ COMMITTED makes the first
      // post-wait ownership read use a fresh snapshot.
      isolationLevel: 'ReadCommitted',
      maxWait: 2_000,
      timeout: 15_000,
    })
  },
}

function makeRecoveryRepositories(
  transaction: Parameters<typeof makeLegacyPrismaContactMergeRepositoriesV1>[0],
): AutomatedMergeRecoveryRepositoriesV1 {
  const contacts = makeLegacyPrismaContactMergeRepositoriesV1(transaction)
  const messaging = makeMessagingContactMergeRepositories(transaction)
  const work = makeWorkContactMergeRepositories(transaction)
  return {
    contacts: contacts.recoveryContacts,
    messaging: messaging.recovery,
    work: work.recovery,
  }
}

const automatedMergeRecoveryUnitOfWorkV1: AutomatedMergeRecoveryUnitOfWorkV1 = {
  run(operation) {
    return prisma.$transaction(
      transaction => operation(makeRecoveryRepositories(transaction)),
      { isolationLevel: 'ReadCommitted', maxWait: 2_000, timeout: 15_000 },
    )
  },
}

export const mergeContactsV1 = createMergeContactsHandlerV1({
  unitOfWork: contactMergeUnitOfWorkV1,
  recoveryUnitOfWork: automatedMergeRecoveryUnitOfWorkV1,
})
