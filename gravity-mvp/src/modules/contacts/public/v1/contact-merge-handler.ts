import {
  MERGE_CONTACTS_RESULT_V1,
  parseMergeContactsCommandV1,
  type MergeContactsCommandV1,
  type MergeContactsResultV1,
} from '../../../../contracts/contacts/v1'

export type ContactMergeErrorCodeV1 =
  | 'CONTACT_NOT_FOUND'
  | 'DRIVER_NOT_FOUND'
  | 'CONTACT_ARCHIVED'
  | 'SURVIVOR_ARCHIVED'
  | 'CONTACT_LINKED_TO_OTHER_DRIVER'
  | 'ALREADY_MERGED'
  | 'SELF_MERGE'
  | 'SOURCE_HAS_DRIVER'
  | 'INVALID_MERGE_STATE'

export class ContactMergeErrorV1 extends Error {
  readonly code: ContactMergeErrorCodeV1

  constructor(code: ContactMergeErrorCodeV1, message: string) {
    super(message)
    this.name = 'MergeError'
    this.code = code
  }
}

export interface ContactMergePhoneV1 {
  id: string
  phone: string
  isPrimary: boolean
  source: string
  isActive: boolean
}

export interface ContactMergeIdentityV1 {
  id: string
  channel: string
  externalId: string
  displayName: string | null
  reachabilityStatus: string
}

export interface ContactMergeSourceV1 {
  id: string
  displayName: string
  displayNameSource: string
  masterSource: string
  yandexDriverId: string | null
  notes: string | null
  tags: string[]
  isArchived: boolean
  phones: ContactMergePhoneV1[]
  identities: ContactMergeIdentityV1[]
  chats: Array<{ id: string }>
  tasks: Array<{ id: string }>
}

export interface ContactMergeSurvivorV1 {
  id: string
  yandexDriverId: string | null
  isArchived: boolean
  phones: Array<{ id: string; phone: string }>
  identities: Array<{ id: string; channel: string; externalId: string }>
}

export interface ContactMergeDriverV1 {
  id: string
  yandexDriverId: string
  fullName: string
}

export interface ContactMergeSnapshotV1 {
  contact: {
    id: string
    displayName: string
    displayNameSource: string
    masterSource: string
    yandexDriverId: string | null
    notes: string | null
    tags: string[]
  }
  phones: ContactMergePhoneV1[]
  identities: ContactMergeIdentityV1[]
  chatIds: string[]
  taskIds: string[]
}

export interface ContactMergeContactsQueryRepositoryV1 {
  findSourceContact(contactId: string): Promise<ContactMergeSourceV1 | null>
  findTargetContact(contactId: string): Promise<ContactMergeSurvivorV1 | null>
  findSurvivorByYandexDriverId(yandexDriverId: string): Promise<ContactMergeSurvivorV1 | null>
  hasCompletedMerge(sourceId: string, targetId: string): Promise<boolean>
}

export interface ContactMergeFleetQueryRepositoryV1 {
  findDriverById(driverId: string): Promise<ContactMergeDriverV1 | null>
}

export interface ContactMergeQueryRepositoriesV1 {
  contacts: ContactMergeContactsQueryRepositoryV1
  fleet: ContactMergeFleetQueryRepositoryV1
}

export interface ContactMergeSimpleLinkContactsRepositoryV1 {
  linkContactToDriver(input: {
    contactId: string
    driverYandexId: string
    driverFullName: string
    replaceDisplayName: boolean
  }): Promise<void>
}

export interface ContactMergeContactsRepositoryV1 extends ContactMergeSimpleLinkContactsRepositoryV1 {
  lockContactPairOrdered(survivorId: string, mergedId: string): Promise<void>
  deleteDuplicateIdentities(identityIds: string[]): Promise<void>
  moveIdentitiesToContact(sourceContactId: string, targetContactId: string): Promise<void>
  deleteDuplicatePhones(phoneIds: string[]): Promise<void>
  movePhonesToContact(sourceContactId: string, targetContactId: string): Promise<void>
  recordMerge(input: {
    id: string
    survivorId: string
    mergedId: string
    mergedBy: string
    reason: 'manual' | 'yandex_link'
    driverYandexId: string | null
    snapshotBefore: ContactMergeSnapshotV1
  }): Promise<string>
  archiveContact(contactId: string): Promise<void>
}

export interface ContactMergeFleetRepositoryV1 {
  findDriverIdByYandexDriverId(yandexDriverId: string): Promise<string | null>
}

export interface ContactMergeSimpleLinkMessagingRepositoryV1 {
  attachUnlinkedContactChatsToDriver(contactId: string, driverId: string): Promise<void>
}

export interface ContactMergeMessagingRepositoryV1 extends ContactMergeSimpleLinkMessagingRepositoryV1 {
  remapChatsToIdentity(oldIdentityId: string, newIdentityId: string): Promise<void>
  moveChatsToContact(sourceContactId: string, targetContactId: string): Promise<void>
  moveChatsToDriverContact(sourceContactId: string, targetContactId: string, driverId: string): Promise<void>
}

export interface ContactMergeWorkRepositoryV1 {
  moveTasksToContact(sourceContactId: string, targetContactId: string): Promise<void>
}

export interface ContactMergeTransactionalRepositoriesV1 {
  contacts: ContactMergeContactsRepositoryV1
  fleet: ContactMergeFleetRepositoryV1
  messaging: ContactMergeMessagingRepositoryV1
  work: ContactMergeWorkRepositoryV1
}

export interface ContactMergeSimpleLinkRepositoriesV1 {
  contacts: ContactMergeSimpleLinkContactsRepositoryV1
  messaging: ContactMergeSimpleLinkMessagingRepositoryV1
}

export interface ContactMergeUnitOfWorkV1 {
  runSimpleLink(operation: (repositories: ContactMergeSimpleLinkRepositoriesV1) => Promise<void>): Promise<void>
  runMerge(operation: (repositories: ContactMergeTransactionalRepositoriesV1) => Promise<void>): Promise<void>
}

export interface ContactMergeHandlerDependenciesV1 {
  queries: ContactMergeQueryRepositoriesV1
  unitOfWork: ContactMergeUnitOfWorkV1
  generateMergeRecordId?: () => string
  log?: (message: string) => void
}

function generateCuid(): string {
  const timestamp = Date.now().toString(36)
  const random = Math.random().toString(36).substring(2, 10)
  return `cm${timestamp}${random}`
}

function makeSnapshot(source: ContactMergeSourceV1): ContactMergeSnapshotV1 {
  return {
    contact: {
      id: source.id,
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      masterSource: source.masterSource,
      yandexDriverId: source.yandexDriverId,
      notes: source.notes,
      tags: source.tags,
    },
    phones: source.phones.map((phone) => ({
      id: phone.id,
      phone: phone.phone,
      isPrimary: phone.isPrimary,
      source: phone.source,
      isActive: phone.isActive,
    })),
    identities: source.identities.map((identity) => ({
      id: identity.id,
      channel: identity.channel,
      externalId: identity.externalId,
      displayName: identity.displayName,
      reachabilityStatus: identity.reachabilityStatus,
    })),
    chatIds: source.chats.map((chat) => chat.id),
    taskIds: source.tasks.map((task) => task.id),
  }
}

export function createMergeContactsHandlerV1(dependencies: ContactMergeHandlerDependenciesV1) {
  const generateMergeRecordId = dependencies.generateMergeRecordId ?? generateCuid
  const log = dependencies.log ?? ((message: string) => console.log(message))

  async function executeSimpleLink(
    contact: ContactMergeSourceV1,
    driver: ContactMergeDriverV1,
  ): Promise<MergeContactsResultV1> {
    await dependencies.unitOfWork.runSimpleLink(async ({ contacts, messaging }) => {
      await contacts.linkContactToDriver({
        contactId: contact.id,
        driverYandexId: driver.yandexDriverId,
        driverFullName: driver.fullName,
        replaceDisplayName: contact.displayNameSource !== 'manual',
      })

      if (contact.chats.length > 0) {
        await messaging.attachUnlinkedContactChatsToDriver(contact.id, driver.id)
      }
    })

    log(`[ContactMergeService] Simple link: contact=${contact.id} → driver=${driver.yandexDriverId}`)
    return {
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'linked',
      contactId: contact.id,
      driverId: driver.id,
    }
  }

  async function executeDriverMerge(
    merged: ContactMergeSourceV1,
    survivor: ContactMergeSurvivorV1,
    driver: ContactMergeDriverV1,
    mergedBy: string,
  ): Promise<MergeContactsResultV1> {
    let mergeRecordId = ''

    await dependencies.unitOfWork.runMerge(async ({ contacts, messaging, work }) => {
      await contacts.lockContactPairOrdered(survivor.id, merged.id)

      const snapshot = makeSnapshot(merged)
      const survivorIdentityMap = new Map(
        survivor.identities.map((identity) => [`${identity.channel}:${identity.externalId}`, identity.id]),
      )
      const duplicateIdentityIds: string[] = []
      const identityRemapping: Array<{ oldIdentityId: string; newIdentityId: string }> = []

      for (const mergedIdentity of merged.identities) {
        const survivorIdentityId = survivorIdentityMap.get(
          `${mergedIdentity.channel}:${mergedIdentity.externalId}`,
        )
        if (survivorIdentityId) {
          duplicateIdentityIds.push(mergedIdentity.id)
          identityRemapping.push({
            oldIdentityId: mergedIdentity.id,
            newIdentityId: survivorIdentityId,
          })
        }
      }

      for (const remap of identityRemapping) {
        await messaging.remapChatsToIdentity(remap.oldIdentityId, remap.newIdentityId)
      }
      if (duplicateIdentityIds.length > 0) {
        await contacts.deleteDuplicateIdentities(duplicateIdentityIds)
      }
      await contacts.moveIdentitiesToContact(merged.id, survivor.id)

      const survivorPhones = new Set(survivor.phones.map((phone) => phone.phone))
      const duplicatePhoneIds = merged.phones
        .filter((phone) => survivorPhones.has(phone.phone))
        .map((phone) => phone.id)
      if (duplicatePhoneIds.length > 0) {
        await contacts.deleteDuplicatePhones(duplicatePhoneIds)
      }
      await contacts.movePhonesToContact(merged.id, survivor.id)

      await messaging.moveChatsToDriverContact(merged.id, survivor.id, driver.id)
      await messaging.attachUnlinkedContactChatsToDriver(survivor.id, driver.id)
      await work.moveTasksToContact(merged.id, survivor.id)

      mergeRecordId = await contacts.recordMerge({
        id: generateMergeRecordId(),
        survivorId: survivor.id,
        mergedId: merged.id,
        mergedBy,
        reason: 'yandex_link',
        driverYandexId: driver.yandexDriverId,
        snapshotBefore: snapshot,
      })
      await contacts.archiveContact(merged.id)
    })

    log(
      `[ContactMergeService] Full merge: merged=${merged.id} → survivor=${survivor.id} `
      + `driver=${driver.yandexDriverId} mergeRecord=${mergeRecordId}`,
    )
    return {
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'merged',
      survivorId: survivor.id,
      mergedId: merged.id,
      driverId: driver.id,
      mergeRecordId,
    }
  }

  async function executeContactMerge(
    source: ContactMergeSourceV1,
    target: ContactMergeSurvivorV1,
    mergedBy: string,
  ): Promise<MergeContactsResultV1> {
    let mergeRecordId = ''

    await dependencies.unitOfWork.runMerge(async ({ contacts, fleet, messaging, work }) => {
      await contacts.lockContactPairOrdered(target.id, source.id)

      const snapshot = makeSnapshot(source)
      const targetIdentityMap = new Map(
        target.identities.map((identity) => [`${identity.channel}:${identity.externalId}`, identity.id]),
      )
      const duplicateIdentityIds: string[] = []
      const identityRemaps: Array<{ oldId: string; newId: string }> = []

      for (const sourceIdentity of source.identities) {
        const targetIdentityId = targetIdentityMap.get(
          `${sourceIdentity.channel}:${sourceIdentity.externalId}`,
        )
        if (targetIdentityId) {
          duplicateIdentityIds.push(sourceIdentity.id)
          identityRemaps.push({ oldId: sourceIdentity.id, newId: targetIdentityId })
        }
      }

      for (const remap of identityRemaps) {
        await messaging.remapChatsToIdentity(remap.oldId, remap.newId)
      }
      if (duplicateIdentityIds.length > 0) {
        await contacts.deleteDuplicateIdentities(duplicateIdentityIds)
      }
      await contacts.moveIdentitiesToContact(source.id, target.id)

      const targetPhones = new Set(target.phones.map((phone) => phone.phone))
      const duplicatePhoneIds = source.phones
        .filter((phone) => targetPhones.has(phone.phone))
        .map((phone) => phone.id)
      if (duplicatePhoneIds.length > 0) {
        await contacts.deleteDuplicatePhones(duplicatePhoneIds)
      }
      await contacts.movePhonesToContact(source.id, target.id)

      let targetDriverId: string | null = null
      if (target.yandexDriverId) {
        targetDriverId = await fleet.findDriverIdByYandexDriverId(target.yandexDriverId)
      }
      if (targetDriverId) {
        await messaging.moveChatsToDriverContact(source.id, target.id, targetDriverId)
      } else {
        await messaging.moveChatsToContact(source.id, target.id)
      }

      await work.moveTasksToContact(source.id, target.id)
      mergeRecordId = await contacts.recordMerge({
        id: generateMergeRecordId(),
        survivorId: target.id,
        mergedId: source.id,
        mergedBy,
        reason: 'manual',
        driverYandexId: target.yandexDriverId || null,
        snapshotBefore: snapshot,
      })
      await contacts.archiveContact(source.id)
    })

    log(
      `[ContactMergeService] Contact merge: source=${source.id} → target=${target.id} `
      + `mergeRecord=${mergeRecordId}`,
    )
    return {
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'contact_merged',
      survivorId: target.id,
      mergedId: source.id,
      mergeRecordId,
    }
  }

  return async function mergeContactsV1(
    command: MergeContactsCommandV1 | unknown,
  ): Promise<MergeContactsResultV1> {
    const parsed = parseMergeContactsCommandV1(command)

    if (parsed.operation === 'contact_to_driver') {
      const contact = await dependencies.queries.contacts.findSourceContact(parsed.contactId)
      if (!contact) {
        throw new ContactMergeErrorV1('CONTACT_NOT_FOUND', `Contact ${parsed.contactId} not found`)
      }

      const driver = await dependencies.queries.fleet.findDriverById(parsed.driverId)
      if (!driver) {
        throw new ContactMergeErrorV1('DRIVER_NOT_FOUND', `Driver ${parsed.driverId} not found`)
      }
      if (contact.isArchived) {
        throw new ContactMergeErrorV1(
          'CONTACT_ARCHIVED',
          `Contact ${parsed.contactId} is archived (was previously merged)`,
        )
      }
      if (contact.yandexDriverId === driver.yandexDriverId) {
        return {
          contract: MERGE_CONTACTS_RESULT_V1,
          status: 'already_linked',
          contactId: parsed.contactId,
          driverId: parsed.driverId,
        }
      }
      if (contact.yandexDriverId && contact.yandexDriverId !== driver.yandexDriverId) {
        throw new ContactMergeErrorV1(
          'CONTACT_LINKED_TO_OTHER_DRIVER',
          `Contact ${parsed.contactId} is linked to driver ${contact.yandexDriverId}, `
          + `cannot merge to ${driver.yandexDriverId}`,
        )
      }

      const survivor = await dependencies.queries.contacts.findSurvivorByYandexDriverId(
        driver.yandexDriverId,
      )
      if (!survivor) return executeSimpleLink(contact, driver)
      if (survivor.isArchived) {
        throw new ContactMergeErrorV1(
          'SURVIVOR_ARCHIVED',
          `Survivor contact ${survivor.id} is archived`,
        )
      }
      if (contact.id === survivor.id) {
        return {
          contract: MERGE_CONTACTS_RESULT_V1,
          status: 'already_linked',
          contactId: parsed.contactId,
          driverId: parsed.driverId,
        }
      }
      return executeDriverMerge(contact, survivor, driver, parsed.mergedBy)
    }

    if (parsed.sourceId === parsed.targetId) {
      throw new ContactMergeErrorV1('SELF_MERGE', 'Cannot merge contact into itself')
    }

    const source = await dependencies.queries.contacts.findSourceContact(parsed.sourceId)
    if (!source) {
      throw new ContactMergeErrorV1(
        'CONTACT_NOT_FOUND',
        `Source contact ${parsed.sourceId} not found`,
      )
    }
    if (source.isArchived) {
      const alreadyMerged = await dependencies.queries.contacts.hasCompletedMerge(
        parsed.sourceId,
        parsed.targetId,
      )
      if (alreadyMerged) {
        return {
          contract: MERGE_CONTACTS_RESULT_V1,
          status: 'already_merged',
          sourceId: parsed.sourceId,
          targetId: parsed.targetId,
        }
      }
      throw new ContactMergeErrorV1(
        'CONTACT_ARCHIVED',
        `Source contact ${parsed.sourceId} is archived`,
      )
    }
    if (source.yandexDriverId) {
      throw new ContactMergeErrorV1(
        'SOURCE_HAS_DRIVER',
        `Source contact ${parsed.sourceId} is linked to driver ${source.yandexDriverId}. `
        + 'Use this contact as target instead.',
      )
    }

    const target = await dependencies.queries.contacts.findTargetContact(parsed.targetId)
    if (!target) {
      throw new ContactMergeErrorV1(
        'CONTACT_NOT_FOUND',
        `Target contact ${parsed.targetId} not found`,
      )
    }
    if (target.isArchived) {
      throw new ContactMergeErrorV1(
        'SURVIVOR_ARCHIVED',
        `Target contact ${parsed.targetId} is archived`,
      )
    }

    return executeContactMerge(source, target, parsed.mergedBy)
  }
}
