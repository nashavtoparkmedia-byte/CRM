import {
  MERGE_CONTACTS_RESULT_V1,
  parseMergeContactsCommandV1,
  type MergeContactsCommandV1,
  type MergeContactsResultV1,
} from '../../../../contracts/contacts/v1'
import { evaluateAutomaticContactMergeV1, evaluateContactSurvivorV1 } from './contact-automation-policy'
import {
  createRecoverAutomatedContactMergeHandlerV1,
  type AutomatedMergeRecoveryUnitOfWorkV1,
} from './automated-contact-merge-recovery'

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
  providerAccountId: string
  source: string
  phoneId: string | null
}
export interface ContactMergeSourceV1 {
  id: string
  displayName: string
  displayNameSource: string
  masterSource: string
  yandexDriverId: string | null
  mainDriverId: string | null
  mainDriverSelection: string
  mainDriverSelectedBy: string | null
  mainDriverSelectedAt: Date | null
  primaryPhoneId: string | null
  notes: string | null
  tags: string[]
  isArchived: boolean
  phones: ContactMergePhoneV1[]
  identities: ContactMergeIdentityV1[]
  chats: Array<{ id: string }>
  tasks: Array<{ id: string }>
  calls: Array<{ id: string }>
  createdAt: Date
  canonicalPinnedAt: Date | null
  doNotMerge: boolean
  customFields: unknown
  driverProfiles: Array<{ id: string }>
  driverConfirmations: Array<{ profileClusterKey: string; status: string }>
}
export type ContactMergeSurvivorV1 = ContactMergeSourceV1
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
    mainDriverId: string | null
    mainDriverSelection: string
    mainDriverSelectedBy: string | null
    mainDriverSelectedAt: Date | null
    primaryPhoneId: string | null
    notes: string | null
    tags: string[]
    doNotMerge: boolean
    customFields: unknown
  }
  phones: ContactMergePhoneV1[]
  identities: ContactMergeIdentityV1[]
  chatIds: string[]
  taskIds: string[]
  callIds: string[]
  driverProfileIds: string[]
  survivorBefore: Omit<ContactMergeSnapshotV1, 'survivorBefore'> | null
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
  transferDriverLink(input: {
    fromContactId: string
    toContactId: string
    driverYandexId: string
    driverFullName: string
  }): Promise<void>
}
export interface ContactMergeContactsRepositoryV1
  extends ContactMergeSimpleLinkContactsRepositoryV1, ContactMergeContactsQueryRepositoryV1 {
  /** First database action in the enclosing merge transaction. */
  admitOwnershipMutation(): Promise<void>
  lockContactPairOrdered(survivorId: string, mergedId: string): Promise<void>
  deleteDuplicateIdentities(identityIds: string[]): Promise<void>
  moveIdentitiesToContact(sourceContactId: string, targetContactId: string): Promise<void>
  deleteDuplicatePhones(phoneIds: string[]): Promise<void>
  repointIdentitiesToPhone(oldPhoneId: string, newPhoneId: string): Promise<void>
  movePhonesToContact(sourceContactId: string, targetContactId: string): Promise<void>
  reconcilePrimaryPhonesAfterMove(sourceContactId: string, targetContactId: string): Promise<void>
  composeContactState(sourceContactId: string, targetContactId: string): Promise<void>
  recordMerge(input: {
    id: string
    survivorId: string
    mergedId: string
    mergedBy: string
    reason: 'manual' | 'yandex_link'
    driverYandexId: string | null
    snapshotBefore: ContactMergeSnapshotV1
    survivorEvaluation: unknown
    automated: boolean
    evidenceRoots: string[]
  }): Promise<string>
  archiveContact(contactId: string): Promise<void>
  setMergedRedirect(contactId: string, survivorId: string): Promise<void>
  verifyOwnershipPostconditions(): Promise<void>
}
export interface ContactMergeFleetRepositoryV1 extends ContactMergeFleetQueryRepositoryV1 {
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
  run<T>(operation: (repositories: ContactMergeTransactionalRepositoriesV1) => Promise<T>): Promise<T>
}
export interface ContactMergeHandlerDependenciesV1 {
  unitOfWork: ContactMergeUnitOfWorkV1
  recoveryUnitOfWork?: AutomatedMergeRecoveryUnitOfWorkV1
  generateMergeRecordId?: () => string
  log?: (message: string) => void
}

function generateCuid(): string {
  return `cm${Date.now().toString(36)}${Math.random().toString(36).substring(2, 10)}`
}
function makeSnapshotBase(source: ContactMergeSourceV1): Omit<ContactMergeSnapshotV1, 'survivorBefore'> {
  return {
    contact: {
      id: source.id,
      displayName: source.displayName,
      displayNameSource: source.displayNameSource,
      masterSource: source.masterSource,
      yandexDriverId: source.yandexDriverId,
      mainDriverId: source.mainDriverId,
      mainDriverSelection: source.mainDriverSelection,
      mainDriverSelectedBy: source.mainDriverSelectedBy,
      mainDriverSelectedAt: source.mainDriverSelectedAt,
      primaryPhoneId: source.primaryPhoneId,
      notes: source.notes,
      tags: source.tags,
      doNotMerge: source.doNotMerge,
      customFields: source.customFields,
    },
    phones: source.phones.map(phone => ({ ...phone })),
    identities: source.identities.map(identity => ({ ...identity })),
    chatIds: source.chats.map(chat => chat.id),
    taskIds: source.tasks.map(task => task.id),
    callIds: source.calls.map(call => call.id),
    driverProfileIds: source.driverProfiles.map(profile => profile.id),
  }
}
function makeSnapshot(
  source: ContactMergeSourceV1,
  survivor: ContactMergeSurvivorV1,
): ContactMergeSnapshotV1 {
  return { ...makeSnapshotBase(source), survivorBefore: makeSnapshotBase(survivor) }
}
function automationSnapshot(contact: ContactMergeSourceV1) {
  const customFields = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
    ? contact.customFields as Record<string, unknown>
    : null
  const conflicts = Array.isArray(customFields?.identityConflicts)
    ? customFields.identityConflicts.filter(item => (
        item && typeof item === 'object' && !Array.isArray(item)
        && (item as Record<string, unknown>).status === 'open'
      )) as Array<Record<string, unknown>>
    : []
  const recoveryState = typeof customFields?.mergeRecoveryState === 'string'
    ? customFields.mergeRecoveryState
    : null
  return {
    id: contact.id,
    createdAt: contact.createdAt,
    canonicalPinned: Boolean(contact.canonicalPinnedAt),
    doNotMerge: contact.doNotMerge,
    isArchived: contact.isArchived,
    notes: contact.notes,
    tags: contact.tags,
    customFields,
    manualIdentityCount: contact.identities.filter(identity => identity.source === 'manual').length,
    driverRelationshipCount: contact.yandexDriverId || contact.driverProfiles.length > 0 ? 1 : 0,
    activeTaskCount: contact.tasks.length,
    callCount: contact.calls.length,
    chatCount: contact.chats.length,
    messageCount: 0,
    confirmedDriver: contact.driverConfirmations.some(item => item.status === 'confirmed'),
    confirmedPersonKeys: contact.driverConfirmations
      .filter(item => item.status === 'confirmed')
      .map(item => item.profileClusterKey),
    workflowKeys: contact.tasks.map(task => `task:${task.id}`),
    openConflictTypes: [
      ...conflicts
        .map(conflict => conflict.conflictType)
        .filter((type): type is string => typeof type === 'string'),
      ...(recoveryState && recoveryState !== 'clear' ? [`merge_recovery_${recoveryState}`] : []),
    ],
  }
}
async function moveOwnedState(
  repositories: ContactMergeTransactionalRepositoriesV1,
  source: ContactMergeSourceV1,
  target: ContactMergeSurvivorV1,
): Promise<void> {
  const { contacts, messaging } = repositories
  const targetIdentityMap = new Map(
    target.identities.map(identity => [`${identity.channel}:${identity.providerAccountId}:${identity.externalId}`, identity.id]),
  )
  const duplicateIdentityIds: string[] = []
  const identityRemaps: Array<{ oldId: string; newId: string }> = []
  for (const identity of source.identities) {
    const targetIdentityId = targetIdentityMap.get(`${identity.channel}:${identity.providerAccountId}:${identity.externalId}`)
    if (targetIdentityId) {
      duplicateIdentityIds.push(identity.id)
      identityRemaps.push({ oldId: identity.id, newId: targetIdentityId })
    }
  }
  for (const remap of identityRemaps) {
    await messaging.remapChatsToIdentity(remap.oldId, remap.newId)
  }
  if (duplicateIdentityIds.length > 0) await contacts.deleteDuplicateIdentities(duplicateIdentityIds)
  await contacts.moveIdentitiesToContact(source.id, target.id)
  const targetPhones = new Map(target.phones.map(phone => [phone.phone, phone.id]))
  const duplicatePhones = source.phones.filter(phone => targetPhones.has(phone.phone))
  for (const duplicate of duplicatePhones) {
    await contacts.repointIdentitiesToPhone(duplicate.id, targetPhones.get(duplicate.phone)!)
  }
  const duplicatePhoneIds = duplicatePhones.map(phone => phone.id)
  if (duplicatePhoneIds.length > 0) await contacts.deleteDuplicatePhones(duplicatePhoneIds)
  await contacts.movePhonesToContact(source.id, target.id)
  await contacts.reconcilePrimaryPhonesAfterMove(source.id, target.id)
}

export function createMergeContactsHandlerV1(dependencies: ContactMergeHandlerDependenciesV1) {
  const generateMergeRecordId = dependencies.generateMergeRecordId ?? generateCuid
  const log = dependencies.log ?? ((message: string) => console.log(message))
  const mergeContactsV1 = async function mergeContactsV1(
    command: MergeContactsCommandV1 | unknown,
  ): Promise<MergeContactsResultV1> {
    const parsed = parseMergeContactsCommandV1(command)
    return dependencies.unitOfWork.run(async repositories => {
      const { contacts, fleet, messaging, work } = repositories
      await contacts.admitOwnershipMutation()
      if (parsed.operation === 'contact_to_driver') {
        // Discovery is admitted but non-decisional. Re-read after ordered locks.
        const discoveredDriver = await fleet.findDriverById(parsed.driverId)
        const discoveredSurvivor = discoveredDriver
          ? await contacts.findSurvivorByYandexDriverId(discoveredDriver.yandexDriverId)
          : null
        await contacts.lockContactPairOrdered(parsed.contactId, discoveredSurvivor?.id ?? parsed.contactId)
        const contact = await contacts.findSourceContact(parsed.contactId)
        if (!contact) {
          throw new ContactMergeErrorV1('CONTACT_NOT_FOUND', `Contact ${parsed.contactId} not found`)
        }
        const driver = await fleet.findDriverById(parsed.driverId)
        if (!driver) {
          throw new ContactMergeErrorV1('DRIVER_NOT_FOUND', `Driver ${parsed.driverId} not found`)
        }
        if (discoveredDriver && driver.yandexDriverId !== discoveredDriver.yandexDriverId) {
          throw new ContactMergeErrorV1('INVALID_MERGE_STATE', 'Driver changed during admitted discovery')
        }
        if (contact.isArchived) {
          throw new ContactMergeErrorV1('CONTACT_ARCHIVED', `Contact ${parsed.contactId} is archived`)
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
            `Contact ${parsed.contactId} is linked to driver ${contact.yandexDriverId}`,
          )
        }
        const survivor = await contacts.findSurvivorByYandexDriverId(driver.yandexDriverId)
        if (!survivor) {
          await contacts.linkContactToDriver({
            contactId: contact.id,
            driverYandexId: driver.yandexDriverId,
            driverFullName: driver.fullName,
            replaceDisplayName: contact.displayNameSource !== 'manual',
          })
          if (contact.chats.length > 0) {
            await messaging.attachUnlinkedContactChatsToDriver(contact.id, driver.id)
          }
          await contacts.verifyOwnershipPostconditions()
          log(`[ContactMergeService] Simple link: contact=${contact.id} → driver=${driver.yandexDriverId}`)
          return {
            contract: MERGE_CONTACTS_RESULT_V1,
            status: 'linked',
            contactId: contact.id,
            driverId: driver.id,
          }
        }
        if (survivor.id !== discoveredSurvivor?.id) {
          throw new ContactMergeErrorV1('INVALID_MERGE_STATE', 'Survivor changed during admitted discovery')
        }
        if (survivor.isArchived) {
          throw new ContactMergeErrorV1('SURVIVOR_ARCHIVED', `Survivor contact ${survivor.id} is archived`)
        }
        if (contact.id === survivor.id) {
          return {
            contract: MERGE_CONTACTS_RESULT_V1,
            status: 'already_linked',
            contactId: parsed.contactId,
            driverId: parsed.driverId,
          }
        }
        const driverContact = await contacts.findSourceContact(survivor.id)
        if (!driverContact) throw new ContactMergeErrorV1('CONTACT_NOT_FOUND', `Contact ${survivor.id} not found`)
        const evaluation = evaluateContactSurvivorV1(automationSnapshot(contact), automationSnapshot(driverContact))
        const winner = evaluation.survivorId === contact.id ? contact : driverContact
        const loser = evaluation.mergedId === contact.id ? contact : driverContact
        if (winner.id === contact.id) {
          await contacts.transferDriverLink({
            fromContactId: driverContact.id,
            toContactId: contact.id,
            driverYandexId: driver.yandexDriverId,
            driverFullName: driver.fullName,
          })
        }
        const snapshot = makeSnapshot(loser, winner)
        await moveOwnedState(repositories, loser, winner)
        await contacts.composeContactState(loser.id, winner.id)
        await messaging.moveChatsToDriverContact(loser.id, winner.id, driver.id)
        await messaging.attachUnlinkedContactChatsToDriver(winner.id, driver.id)
        await work.moveTasksToContact(loser.id, winner.id)
        const mergeRecordId = await contacts.recordMerge({
          id: generateMergeRecordId(),
          survivorId: winner.id,
          mergedId: loser.id,
          mergedBy: parsed.mergedBy,
          reason: 'yandex_link',
          driverYandexId: driver.yandexDriverId,
          snapshotBefore: snapshot,
          survivorEvaluation: evaluation,
          automated: false,
          evidenceRoots: [],
        })
        await contacts.archiveContact(loser.id)
        await contacts.setMergedRedirect(loser.id, winner.id)
        await contacts.verifyOwnershipPostconditions()
        log(
          `[ContactMergeService] Full merge: merged=${contact.id} → survivor=${survivor.id} `
          + `driver=${driver.yandexDriverId} mergeRecord=${mergeRecordId}`,
        )
        return {
          contract: MERGE_CONTACTS_RESULT_V1,
          status: 'merged',
          survivorId: winner.id,
          mergedId: loser.id,
          driverId: driver.id,
          mergeRecordId,
        }
      }

      if (parsed.sourceId === parsed.targetId) {
        throw new ContactMergeErrorV1('SELF_MERGE', 'Cannot merge contact into itself')
      }
      await contacts.lockContactPairOrdered(parsed.targetId, parsed.sourceId)
      const source = await contacts.findSourceContact(parsed.sourceId)
      if (!source) {
        throw new ContactMergeErrorV1('CONTACT_NOT_FOUND', `Source contact ${parsed.sourceId} not found`)
      }
      if (source.isArchived) {
        if (await contacts.hasCompletedMerge(parsed.sourceId, parsed.targetId)) {
          return {
            contract: MERGE_CONTACTS_RESULT_V1,
            status: 'already_merged',
            sourceId: parsed.sourceId,
            targetId: parsed.targetId,
          }
        }
        throw new ContactMergeErrorV1('CONTACT_ARCHIVED', `Source contact ${parsed.sourceId} is archived`)
      }
      const target = await contacts.findSourceContact(parsed.targetId)
      if (!target) {
        throw new ContactMergeErrorV1('CONTACT_NOT_FOUND', `Target contact ${parsed.targetId} not found`)
      }
      if (target.isArchived) {
        throw new ContactMergeErrorV1('SURVIVOR_ARCHIVED', `Target contact ${parsed.targetId} is archived`)
      }
      let evaluation = evaluateContactSurvivorV1(automationSnapshot(source), automationSnapshot(target))
      let automationEvidenceRoots: string[] = []
      if (parsed.automation) {
        const automaticDecision = evaluateAutomaticContactMergeV1(
          automationSnapshot(source),
          automationSnapshot(target),
          parsed.automation,
        )
        if (automaticDecision.decision === 'blocked') {
          throw new ContactMergeErrorV1(
            'INVALID_MERGE_STATE',
            `Automatic merge blocked after lock: ${automaticDecision.reason}`,
          )
        }
        evaluation = automaticDecision.survivor
        automationEvidenceRoots = automaticDecision.evidenceRoots
      }
      const winner = evaluation.survivorId === source.id ? source : target
      const loser = evaluation.mergedId === source.id ? source : target
      const snapshot = makeSnapshot(loser, winner)
      await moveOwnedState(repositories, loser, winner)
      await contacts.composeContactState(loser.id, winner.id)
      const composedYandexDriverId = winner.yandexDriverId ?? loser.yandexDriverId
      const targetDriverId = composedYandexDriverId
        ? await fleet.findDriverIdByYandexDriverId(composedYandexDriverId)
        : null
      if (targetDriverId) {
        await messaging.moveChatsToDriverContact(loser.id, winner.id, targetDriverId)
      } else {
        await messaging.moveChatsToContact(loser.id, winner.id)
      }
      await work.moveTasksToContact(loser.id, winner.id)
      const mergeRecordId = await contacts.recordMerge({
        id: generateMergeRecordId(),
        survivorId: winner.id,
        mergedId: loser.id,
        mergedBy: parsed.mergedBy,
        reason: 'manual',
        driverYandexId: composedYandexDriverId,
        snapshotBefore: snapshot,
        survivorEvaluation: evaluation,
        automated: Boolean(parsed.automation),
        evidenceRoots: automationEvidenceRoots,
      })
      await contacts.archiveContact(loser.id)
      await contacts.setMergedRedirect(loser.id, winner.id)
      await contacts.verifyOwnershipPostconditions()
      log(
        `[ContactMergeService] Contact merge: source=${source.id} → target=${target.id} `
        + `mergeRecord=${mergeRecordId}`,
      )
      return {
        contract: MERGE_CONTACTS_RESULT_V1,
        status: 'contact_merged',
        survivorId: winner.id,
        mergedId: loser.id,
        mergeRecordId,
      }
    })
  }
  const recover = dependencies.recoveryUnitOfWork
    ? createRecoverAutomatedContactMergeHandlerV1(dependencies.recoveryUnitOfWork)
    : async () => { throw new Error('Automated contact merge recovery is not configured') }
  return Object.assign(mergeContactsV1, { recover })
}
