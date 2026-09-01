import type { Prisma } from '@prisma/client'
import type {
  ContactMergeSourceV1,
  ContactMergeTransactionalRepositoriesV1,
} from './contact-merge-handler'
import { makePrismaAutomatedMergeRecoveryContactsRepositoryV1 } from '../../internal/legacy-prisma-automated-merge-recovery-adapter'
import {
  admitContactOwnershipTransaction,
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  type ContactOwnershipLockedScope,
} from '../../internal/contact-ownership-coordinator'
import {
  contactAutomationState,
  identityEvidenceState,
  jsonRecord,
} from './contact-evidence-state'

const contactMergeInclude = {
  phones: true,
  identities: true,
  chats: { select: { id: true } },
  tasks: { select: { id: true } },
  calls: { select: { id: true } },
  driverProfiles: { select: { id: true } },
  driver: { select: { id: true } },
  mainDriver: { select: { id: true } },
} satisfies Prisma.ContactInclude

type ContactMergeRow = Prisma.ContactGetPayload<{ include: typeof contactMergeInclude }>

function normalizeContactMergeRow(row: ContactMergeRow | null): ContactMergeSourceV1 | null {
  if (!row) return null
  const { driver, mainDriver, ...contact } = row
  const driverProfiles = new Map(contact.driverProfiles.map(profile => [profile.id, profile]))
  if (driver) driverProfiles.set(driver.id, driver)
  if (mainDriver) driverProfiles.set(mainDriver.id, mainDriver)
  const customFields = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
    ? contact.customFields as Prisma.JsonObject
    : {}
  const driverConfirmations = Array.isArray(customFields.driverConfirmations)
    ? customFields.driverConfirmations
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({
        profileClusterKey: String((item as Prisma.JsonObject).profileClusterKey ?? ''),
        status: String((item as Prisma.JsonObject).status ?? ''),
      }))
      .filter(item => item.profileClusterKey)
    : []
  const automation = contactAutomationState(customFields)
  return {
    ...contact,
    identities: contact.identities.map(identity => ({
      ...identity,
      providerAccountId: identityEvidenceState(identity.metadata).providerAccountId,
    })),
    canonicalPinnedAt: automation.canonicalPinnedAt ? new Date(automation.canonicalPinnedAt) : null,
    doNotMerge: automation.doNotMerge,
    driverProfiles: [...driverProfiles.values()],
    driverConfirmations,
  }
}

/**
 * Contacts' exact contribution to a contact-merge transaction.  The platform
 * composition root supplies the remaining owner capabilities while retaining
 * the single transaction boundary; this adapter never reaches into Messaging
 * or Work Management.
 * contact-ownership-coordinator: admitted-transaction-adapter
 */
export function makeLegacyPrismaContactMergeRepositoriesV1(
  transaction: Prisma.TransactionClient,
): Pick<ContactMergeTransactionalRepositoriesV1, 'contacts' | 'fleet'> & {
  recoveryContacts: ReturnType<typeof makePrismaAutomatedMergeRecoveryContactsRepositoryV1>
} {
  let lockedScope: ContactOwnershipLockedScope | null = null
  return {
    fleet: {
      async findDriverById(driverId) {
        return transaction.driver.findUnique({
          where: { id: driverId },
          select: { id: true, yandexDriverId: true, fullName: true },
        })
      },
      async findDriverIdByYandexDriverId(yandexDriverId) {
        const driver = await transaction.driver.findUnique({
          where: { yandexDriverId },
          select: { id: true },
        })
        return driver?.id ?? null
      },
    },
    recoveryContacts: makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction),
    contacts: {
      async admitOwnershipMutation() {
        await admitContactOwnershipTransaction(transaction)
      },

      async findSourceContact(contactId) {
        const contact = await transaction.contact.findUnique({
          where: { id: contactId },
          include: contactMergeInclude,
        })
        return normalizeContactMergeRow(contact)
      },

      async findTargetContact(contactId) {
        const contact = await transaction.contact.findUnique({
          where: { id: contactId },
          include: contactMergeInclude,
        })
        return normalizeContactMergeRow(contact)
      },

      async findSurvivorByYandexDriverId(yandexDriverId) {
        const contact = await transaction.contact.findUnique({
          where: { yandexDriverId },
          include: contactMergeInclude,
        })
        return normalizeContactMergeRow(contact)
      },

      async hasCompletedMerge(sourceId, targetId) {
        const existing = await transaction.contactMerge.findFirst({
          where: { mergedId: sourceId, survivorId: targetId, action: 'merge' },
          select: { id: true },
        })
        return existing !== null
      },

      async lockContactPairOrdered(survivorId, mergedId) {
        lockedScope = await lockContactOwnershipRows(transaction, {
          contactIds: [survivorId, mergedId],
        })
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

      async transferDriverLink(input) {
        await transaction.contact.update({
          where: { id: input.fromContactId },
          data: { yandexDriverId: null },
        })
        await transaction.contact.update({
          where: { id: input.toContactId },
          data: {
            yandexDriverId: input.driverYandexId,
            masterSource: 'yandex',
            displayName: input.driverFullName,
            displayNameSource: 'yandex',
          },
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

      async repointIdentitiesToPhone(oldPhoneId, newPhoneId) {
        await transaction.contactIdentity.updateMany({
          where: { phoneId: oldPhoneId },
          data: { phoneId: newPhoneId },
        })
      },

      async movePhonesToContact(sourceContactId, targetContactId) {
        await transaction.contactPhone.updateMany({
          where: { contactId: sourceContactId },
          data: { contactId: targetContactId },
        })
      },

      async reconcilePrimaryPhonesAfterMove(sourceContactId, targetContactId) {
        await transaction.contact.update({
          where: { id: sourceContactId },
          data: { primaryPhoneId: null },
        })
        const target = await transaction.contact.findUnique({
          where: { id: targetContactId },
          select: { primaryPhoneId: true },
        })
        const validCurrent = target?.primaryPhoneId
          ? await transaction.contactPhone.findFirst({
              where: {
                id: target.primaryPhoneId,
                contactId: targetContactId,
                isActive: true,
              },
              select: { id: true },
            })
          : null
        const selected = validCurrent ?? await transaction.contactPhone.findFirst({
          where: { contactId: targetContactId, isActive: true },
          orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
          select: { id: true },
        })
        await transaction.contactPhone.updateMany({
          where: { contactId: targetContactId, isPrimary: true, NOT: { id: selected?.id } },
          data: { isPrimary: false },
        })
        if (selected) {
          await transaction.contactPhone.update({
            where: { id: selected.id },
            data: { isPrimary: true },
          })
        }
        await transaction.contact.update({
          where: { id: targetContactId },
          data: { primaryPhoneId: selected?.id ?? null },
        })
      },

      async composeContactState(sourceContactId, targetContactId) {
        const [source, target] = await Promise.all([
          transaction.contact.findUnique({ where: { id: sourceContactId } }),
          transaction.contact.findUnique({ where: { id: targetContactId } }),
        ])
        if (!source || !target) throw new Error('CONTACT_MERGE_STATE_MISSING')
        const sourceFields = source.customFields && typeof source.customFields === 'object' && !Array.isArray(source.customFields)
          ? source.customFields as Prisma.JsonObject
          : {}
        const targetFields = target.customFields && typeof target.customFields === 'object' && !Array.isArray(target.customFields)
          ? target.customFields as Prisma.JsonObject
          : {}
        const useSourceMainDriver = !target.mainDriverId && Boolean(source.mainDriverId)
        const sourceAutomation = contactAutomationState(sourceFields)
        const targetAutomation = contactAutomationState(targetFields)
        const sourcePhoneEvidence = jsonRecord(sourceFields.phoneEvidenceByPhoneId)
        const targetPhoneEvidence = jsonRecord(targetFields.phoneEvidenceByPhoneId)
        await transaction.contact.update({
          where: { id: sourceContactId },
          data: { yandexDriverId: null, mainDriverId: null },
        })
        await transaction.contact.update({
          where: { id: targetContactId },
          data: {
            yandexDriverId: target.yandexDriverId ?? source.yandexDriverId,
            mainDriverId: target.mainDriverId ?? source.mainDriverId,
            mainDriverSelection: useSourceMainDriver ? source.mainDriverSelection : target.mainDriverSelection,
            mainDriverSelectedBy: useSourceMainDriver ? source.mainDriverSelectedBy : target.mainDriverSelectedBy,
            mainDriverSelectedAt: useSourceMainDriver ? source.mainDriverSelectedAt : target.mainDriverSelectedAt,
            tags: [...new Set([...target.tags, ...source.tags])],
            notes: target.notes || source.notes,
            customFields: {
              ...sourceFields,
              ...targetFields,
              doNotMerge: targetAutomation.doNotMerge || sourceAutomation.doNotMerge,
              phoneEvidenceByPhoneId: { ...sourcePhoneEvidence, ...targetPhoneEvidence },
            } as Prisma.InputJsonObject,
          },
        })
      },

      async recordMerge(input) {
        const recoveryState = input.automated ? 'recoverable' : 'clear'
        const snapshotBefore = {
          ...input.snapshotBefore,
          _merge: {
            automated: input.automated,
            evidenceRoots: input.evidenceRoots,
            survivorEvaluation: input.survivorEvaluation,
            recoveryState,
          },
        } as unknown as Prisma.InputJsonValue
        const mergeResult = await transaction.contactMerge.create({
          data: {
            id: input.id,
            survivorId: input.survivorId,
            mergedId: input.mergedId,
            action: 'merge',
            mergedBy: input.mergedBy,
            reason: input.reason,
            confidence: 1,
            driverYandexId: input.driverYandexId,
            snapshotBefore,
          },
          select: { id: true },
        })
        if (input.automated) {
          for (const contactId of [input.survivorId, input.mergedId]) {
            const contact = await transaction.contact.findUnique({
              where: { id: contactId },
              select: { customFields: true },
            })
            await transaction.contact.update({
              where: { id: contactId },
              data: {
                customFields: {
                  ...jsonRecord(contact?.customFields),
                  mergeRecoveryState: 'recoverable',
                } as Prisma.InputJsonObject,
              },
            })
          }
        }
        return mergeResult.id
      },

      async archiveContact(contactId) {
        await transaction.contact.update({
          where: { id: contactId },
          data: { isArchived: true, primaryPhoneId: null },
        })
      },

      async setMergedRedirect(contactId, survivorId) {
        const descendants = await transaction.contact.findMany({
          where: { customFields: { path: ['mergedIntoContactId'], equals: contactId } },
          select: { id: true, customFields: true },
        })
        for (const descendant of descendants) {
          await transaction.contact.update({
            where: { id: descendant.id },
            data: {
              customFields: {
                ...jsonRecord(descendant.customFields),
                mergedIntoContactId: survivorId,
              } as Prisma.InputJsonObject,
            },
          })
        }
        const merged = await transaction.contact.findUnique({
          where: { id: contactId },
          select: { customFields: true },
        })
        await transaction.contact.update({
          where: { id: contactId },
          data: {
            customFields: {
              ...jsonRecord(merged?.customFields),
              mergedIntoContactId: survivorId,
            } as Prisma.InputJsonObject,
          },
        })
      },

      async verifyOwnershipPostconditions() {
        if (!lockedScope) throw new Error('Contact merge mutation was not row-locked')
        await assertContactOwnershipPostconditions(transaction, lockedScope)
      },
    },
  }
}
