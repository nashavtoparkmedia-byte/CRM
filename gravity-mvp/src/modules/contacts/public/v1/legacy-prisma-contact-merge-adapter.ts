import { prisma } from '@/lib/prisma'
import type { Prisma } from '@prisma/client'
import type {
  ContactMergeQueryRepositoriesV1,
  ContactMergeSimpleLinkRepositoriesV1,
  ContactMergeTransactionalRepositoriesV1,
  ContactMergeUnitOfWorkV1,
} from './contact-merge-handler'
import { makeMessagingContactMergeRepositories } from '../../../messaging/public/v1/legacy-prisma-contact-merge-adapter'
import { makeWorkContactMergeRepositories } from '../../../work-management/public/v1/legacy-prisma-contact-merge-adapter'

export const legacyPrismaContactMergeQueriesV1: ContactMergeQueryRepositoriesV1 = {
  contacts: {
    async findSourceContact(contactId) {
      return prisma.contact.findUnique({
        where: { id: contactId },
        include: {
          phones: true,
          identities: true,
          chats: { select: { id: true } },
          tasks: { select: { id: true } },
        },
      })
    },

    async findTargetContact(contactId) {
      return prisma.contact.findUnique({
        where: { id: contactId },
        include: {
          phones: true,
          identities: true,
        },
      })
    },

    async findSurvivorByYandexDriverId(yandexDriverId) {
      return prisma.contact.findUnique({
        where: { yandexDriverId },
        include: {
          phones: true,
          identities: true,
        },
      })
    },

    async hasCompletedMerge(sourceId, targetId) {
      const existingMerge = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM "ContactMerge"
        WHERE "mergedId" = ${sourceId} AND "survivorId" = ${targetId} AND action = 'merge'
        LIMIT 1
      `
      return existingMerge.length > 0
    },
  },

  fleet: {
    async findDriverById(driverId) {
      return prisma.driver.findUnique({
        where: { id: driverId },
        select: { id: true, yandexDriverId: true, fullName: true },
      })
    },
  },
}

function makeSimpleLinkRepositories(
  repositories: ContactMergeTransactionalRepositoriesV1,
): ContactMergeSimpleLinkRepositoriesV1 {
  return {
    contacts: {
      linkContactToDriver: repositories.contacts.linkContactToDriver,
    },
    messaging: {
      attachUnlinkedContactChatsToDriver: repositories.messaging.attachUnlinkedContactChatsToDriver,
    },
  }
}

function makeTransactionalRepositories(
  transaction: Prisma.TransactionClient,
): ContactMergeTransactionalRepositoriesV1 {
  return {
    contacts: {
      async lockContactPairOrdered(survivorId, mergedId) {
        await transaction.$queryRaw`
          SELECT id FROM "Contact"
          WHERE id IN (${survivorId}, ${mergedId})
          ORDER BY id
          FOR UPDATE
        `
      },

      async linkContactToDriver(input) {
        const data = input.replaceDisplayName
          ? {
              yandexDriverId: input.driverYandexId,
              masterSource: 'yandex' as const,
              displayName: input.driverFullName,
              displayNameSource: 'yandex' as const,
            }
          : {
              yandexDriverId: input.driverYandexId,
              masterSource: 'yandex' as const,
            }
        await transaction.contact.update({
          where: { id: input.contactId },
          data,
        })
      },

      async deleteDuplicateIdentities(identityIds) {
        await transaction.contactIdentity.deleteMany({
          where: { id: { in: identityIds } },
        })
      },

      async moveIdentitiesToContact(sourceContactId, targetContactId) {
        await transaction.contactIdentity.updateMany({
          where: { contactId: sourceContactId },
          data: { contactId: targetContactId },
        })
      },

      async deleteDuplicatePhones(phoneIds) {
        await transaction.contactPhone.deleteMany({
          where: { id: { in: phoneIds } },
        })
      },

      async movePhonesToContact(sourceContactId, targetContactId) {
        await transaction.contactPhone.updateMany({
          where: { contactId: sourceContactId },
          data: { contactId: targetContactId },
        })
      },

      async recordMerge(input) {
        const mergeResult = input.reason === 'manual'
          ? await transaction.$queryRaw<Array<{ id: string }>>`
              INSERT INTO "ContactMerge" (id, "survivorId", "mergedId", action, "mergedBy", reason, confidence, "driverYandexId", "snapshotBefore", "createdAt")
              VALUES (
                ${input.id},
                ${input.survivorId},
                ${input.mergedId},
                'merge',
                ${input.mergedBy},
                'manual',
                ${1.0},
                ${input.driverYandexId},
                ${JSON.stringify(input.snapshotBefore)}::jsonb,
                NOW()
              )
              RETURNING id
            `
          : await transaction.$queryRaw<Array<{ id: string }>>`
              INSERT INTO "ContactMerge" (id, "survivorId", "mergedId", action, "mergedBy", reason, confidence, "driverYandexId", "snapshotBefore", "createdAt")
              VALUES (
                ${input.id},
                ${input.survivorId},
                ${input.mergedId},
                'merge',
                ${input.mergedBy},
                'yandex_link',
                ${1.0},
                ${input.driverYandexId},
                ${JSON.stringify(input.snapshotBefore)}::jsonb,
                NOW()
              )
              RETURNING id
            `
        return mergeResult[0].id
      },

      async archiveContact(contactId) {
        await transaction.contact.update({
          where: { id: contactId },
          data: { isArchived: true },
        })
      },
    },

    fleet: {
      async findDriverIdByYandexDriverId(yandexDriverId) {
        const driver = await transaction.driver.findUnique({
          where: { yandexDriverId },
          select: { id: true },
        })
        return driver?.id ?? null
      },
    },

    messaging: makeMessagingContactMergeRepositories(transaction),

    work: makeWorkContactMergeRepositories(transaction),
  }
}

export const legacyPrismaContactMergeUnitOfWorkV1: ContactMergeUnitOfWorkV1 = {
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
