import { describe, expect, it, vi } from 'vitest'
import {
  MERGE_CONTACTS_COMMAND_V1,
  MERGE_CONTACTS_RESULT_V1,
  MergeContactsCommandValidationError,
  parseMergeContactsCommandV1,
} from '../../../../contracts/contacts/v1'
import {
  ContactMergeErrorV1,
  createMergeContactsHandlerV1,
  type ContactMergeDriverV1,
  type ContactMergeQueryRepositoriesV1,
  type ContactMergeSourceV1,
  type ContactMergeSurvivorV1,
  type ContactMergeTransactionalRepositoriesV1,
  type ContactMergeUnitOfWorkV1,
} from './contact-merge-handler'

function source(overrides: Partial<ContactMergeSourceV1> = {}): ContactMergeSourceV1 {
  return {
    id: 'source-contact',
    displayName: 'Source Name',
    displayNameSource: 'channel',
    masterSource: 'chat',
    yandexDriverId: null,
    mainDriverId: null,
    mainDriverSelection: 'auto',
    mainDriverSelectedBy: null,
    mainDriverSelectedAt: null,
    primaryPhoneId: 'phone-duplicate',
    notes: 'source notes',
    tags: ['lead'],
    isArchived: false,
    phones: [
      { id: 'phone-duplicate', phone: '+70000000001', isPrimary: true, source: 'telegram', isActive: true },
      { id: 'phone-move', phone: '+70000000002', isPrimary: false, source: 'manual', isActive: true },
    ],
    identities: [
      {
        id: 'identity-duplicate',
        channel: 'telegram',
        externalId: 'shared-external',
        displayName: 'Source Telegram',
        reachabilityStatus: 'confirmed',
        providerAccountId: 'legacy',
        source: 'auto',
        phoneId: 'phone-duplicate',
      },
      {
        id: 'identity-move',
        channel: 'max',
        externalId: 'source-only',
        displayName: null,
        reachabilityStatus: 'unknown',
        providerAccountId: 'legacy',
        source: 'auto',
        phoneId: 'phone-move',
      },
    ],
    chats: [{ id: 'chat-1' }],
    tasks: [{ id: 'task-1' }],
    calls: [],
    createdAt: new Date('2025-01-02T00:00:00.000Z'),
    canonicalPinnedAt: null,
    doNotMerge: false,
    customFields: {},
    driverProfiles: [],
    driverConfirmations: [],
    ...overrides,
  }
}

function survivor(overrides: Partial<ContactMergeSurvivorV1> = {}): ContactMergeSurvivorV1 {
  return source({
    id: 'survivor-contact',
    displayName: 'Survivor Name',
    notes: null,
    tags: [],
    yandexDriverId: 'yandex-driver',
    primaryPhoneId: 'survivor-phone',
    isArchived: false,
    phones: [{
      id: 'survivor-phone', phone: '+70000000001', isPrimary: true, source: 'manual', isActive: true,
    }],
    identities: [{
      id: 'survivor-identity', channel: 'telegram', externalId: 'shared-external',
      displayName: null, reachabilityStatus: 'confirmed', providerAccountId: 'legacy', source: 'auto',
      phoneId: 'survivor-phone',
    }],
    chats: [],
    tasks: [],
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    canonicalPinnedAt: new Date('2025-01-01T00:00:00.000Z'),
    ...overrides,
  })
}

const defaultDriver: ContactMergeDriverV1 = {
  id: 'driver-db-id',
  yandexDriverId: 'yandex-driver',
  fullName: 'Driver Name',
}

interface RepositoryCall {
  name: string
  args: unknown[]
}

interface HarnessOptions {
  sources?: Record<string, ContactMergeSourceV1 | null>
  targets?: Record<string, ContactMergeSurvivorV1 | null>
  survivorByYandexDriverId?: ContactMergeSurvivorV1 | null
  driver?: ContactMergeDriverV1 | null
  completedMerge?: boolean
  targetDriverId?: string | null
  automaticEvidence?: {
    trustedUniqueCurrentPhone: boolean
    phoneEvidenceRoot: string | null
    confirmedPersonEvidenceRoots: string[]
    normalizedVuEvidenceRoots: string[]
  }
  failAt?: string
}

function makeHarness(options: HarnessOptions = {}) {
  const attempted: RepositoryCall[] = []
  const committed: RepositoryCall[] = []
  const logs: string[] = []
  const admitOwnershipMutation = vi.fn(async () => undefined)
  let currentStage: RepositoryCall[] | null = null

  async function stage(name: string, ...args: unknown[]): Promise<void> {
    const call = { name, args }
    attempted.push(call)
    currentStage?.push(call)
    if (options.failAt === name) throw new Error(`injected failure: ${name}`)
  }

  const sources = options.sources ?? { 'source-contact': source() }
  const targets = options.targets ?? { 'target-contact': survivor({ id: 'target-contact' }) }
  const survivorForDriver = options.survivorByYandexDriverId ?? null
  const queries: ContactMergeQueryRepositoriesV1 = {
    contacts: {
      findSourceContact: vi.fn(async (contactId: string) => sources[contactId]
        ?? targets[contactId]
        ?? (survivorForDriver?.id === contactId ? survivorForDriver : null)),
      findTargetContact: vi.fn(async (contactId: string) => targets[contactId] ?? null),
      findSurvivorByYandexDriverId: vi.fn(async () => survivorForDriver),
      hasCompletedMerge: vi.fn(async () => options.completedMerge ?? false),
    },
    fleet: {
      findDriverById: vi.fn(async () => options.driver === undefined ? defaultDriver : options.driver),
    },
  }

  const repositories: ContactMergeTransactionalRepositoriesV1 = {
    contacts: {
      admitOwnershipMutation,
      async findSourceContact(contactId) {
        return queries.contacts.findSourceContact(contactId)
      },
      async findTargetContact(contactId) {
        return queries.contacts.findTargetContact(contactId)
      },
      async findSurvivorByYandexDriverId(yandexDriverId) {
        return queries.contacts.findSurvivorByYandexDriverId(yandexDriverId)
      },
      async hasCompletedMerge(sourceId, targetId) {
        return queries.contacts.hasCompletedMerge(sourceId, targetId)
      },
      async lockContactPairOrdered(survivorId, mergedId) {
        await stage('contacts.lockContactPairOrdered', survivorId, mergedId)
      },
      async deriveAutomaticMergeEvidence() {
        await stage('contacts.deriveAutomaticMergeEvidence')
        return options.automaticEvidence ?? {
          trustedUniqueCurrentPhone: false,
          phoneEvidenceRoot: null,
          confirmedPersonEvidenceRoots: [],
          normalizedVuEvidenceRoots: [],
        }
      },
      async linkContactToDriver(input) {
        await stage('contacts.linkContactToDriver', input)
      },
      async transferDriverLink(input) {
        await stage('contacts.transferDriverLink', input)
      },
      async deleteDuplicateIdentities(identityIds) {
        await stage('contacts.deleteDuplicateIdentities', identityIds)
      },
      async moveIdentitiesToContact(sourceContactId, targetContactId) {
        await stage('contacts.moveIdentitiesToContact', sourceContactId, targetContactId)
      },
      async deleteDuplicatePhones(phoneIds) {
        await stage('contacts.deleteDuplicatePhones', phoneIds)
      },
      async repointIdentitiesToPhone(oldPhoneId, newPhoneId) {
        await stage('contacts.repointIdentitiesToPhone', oldPhoneId, newPhoneId)
      },
      async movePhonesToContact(sourceContactId, targetContactId) {
        await stage('contacts.movePhonesToContact', sourceContactId, targetContactId)
      },
      async reconcilePrimaryPhonesAfterMove(sourceContactId, targetContactId) {
        await stage('contacts.reconcilePrimaryPhonesAfterMove', sourceContactId, targetContactId)
      },
      async composeContactState(sourceContactId, targetContactId) {
        await stage('contacts.composeContactState', sourceContactId, targetContactId)
      },
      async recordMerge(input) {
        await stage('contacts.recordMerge', input)
        return input.id
      },
      async archiveContact(contactId) {
        await stage('contacts.archiveContact', contactId)
      },
      async setMergedRedirect(contactId, survivorId) {
        await stage('contacts.setMergedRedirect', contactId, survivorId)
      },
      async verifyOwnershipPostconditions() {
        await stage('contacts.verifyOwnershipPostconditions')
      },
    },
    fleet: {
      async findDriverById(driverId) {
        return queries.fleet.findDriverById(driverId)
      },
      async findDriverIdByYandexDriverId(yandexDriverId) {
        await stage('fleet.findDriverIdByYandexDriverId', yandexDriverId)
        return options.targetDriverId ?? null
      },
      async moveDriverProfilesToContact(sourceContactId, targetContactId) {
        await stage('fleet.moveDriverProfilesToContact', sourceContactId, targetContactId)
      },
    },
    messaging: {
      async remapChatsToIdentity(oldIdentityId, newIdentityId) {
        await stage('messaging.remapChatsToIdentity', oldIdentityId, newIdentityId)
      },
      async moveChatsToContact(sourceContactId, targetContactId) {
        await stage('messaging.moveChatsToContact', sourceContactId, targetContactId)
      },
      async moveChatsToDriverContact(sourceContactId, targetContactId, driverId) {
        await stage('messaging.moveChatsToDriverContact', sourceContactId, targetContactId, driverId)
      },
      async attachUnlinkedContactChatsToDriver(contactId, driverId) {
        await stage('messaging.attachUnlinkedContactChatsToDriver', contactId, driverId)
      },
    },
    work: {
      async moveTasksToContact(sourceContactId, targetContactId) {
        await stage('work.moveTasksToContact', sourceContactId, targetContactId)
      },
    },
    calling: {
      async moveCallsToContact(sourceContactId, targetContactId) {
        await stage('calling.moveCallsToContact', sourceContactId, targetContactId)
      },
    },
  }

  async function runStaged(operation: () => Promise<void>): Promise<void> {
    const staged: RepositoryCall[] = []
    currentStage = staged
    try {
      await operation()
      committed.push(...staged)
    } finally {
      currentStage = null
    }
  }

  const unitOfWork: ContactMergeUnitOfWorkV1 = {
    async run(operation) {
      let result
      await runStaged(async () => { result = await operation(repositories) })
      return result!
    },
  }

  const handler = createMergeContactsHandlerV1({
    unitOfWork,
    generateMergeRecordId: () => 'generated-merge-id',
    log: (message) => logs.push(message),
  })

  return { attempted, committed, handler, logs, queries }
}

function names(calls: RepositoryCall[]): string[] {
  return calls.map((call) => call.name)
}

describe('MergeContactsCommand.v1 contract', () => {
  it('parses both exact command variants and preserves empty legacy strings', () => {
    expect(parseMergeContactsCommandV1({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: '',
      driverId: ' ',
      mergedBy: '',
    })).toEqual({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: '',
      driverId: ' ',
      mergedBy: '',
    })
    expect(parseMergeContactsCommandV1({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source',
      targetId: 'target',
      mergedBy: 'manager',
    })).toMatchObject({ operation: 'contact_to_contact', sourceId: 'source', targetId: 'target' })
  })

  it('rejects an unsupported version distinctly', () => {
    expect(() => parseMergeContactsCommandV1({
      contract: 'contacts.MergeContactsCommand.v2',
      operation: 'contact_to_driver',
      contactId: 'source',
      driverId: 'driver',
      mergedBy: 'system',
    })).toThrow(expect.objectContaining({
      code: 'UNSUPPORTED_CONTRACT_VERSION',
      name: 'MergeContactsCommandValidationError',
    }))
  })

  it.each([
    null,
    [],
    { contract: MERGE_CONTACTS_COMMAND_V1, operation: 'unknown' },
    {
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source',
      driverId: 'driver',
      mergedBy: 'system',
      transaction: {},
    },
    {
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source',
      targetId: 'target',
      mergedBy: 7,
    },
  ])('rejects malformed or capability-expanding input %#', (input) => {
    expect(() => parseMergeContactsCommandV1(input)).toThrow(MergeContactsCommandValidationError)
  })
})

describe('MergeContactsCommand.v1 preconditions', () => {
  it('preserves driver lookup ordering and exact DRIVER_NOT_FOUND behavior', async () => {
    const harness = makeHarness({ driver: null })

    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'missing-driver',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      name: 'MergeError',
      code: 'DRIVER_NOT_FOUND',
      message: 'Driver missing-driver not found',
    })
    expect(harness.queries.fleet.findDriverById).toHaveBeenCalledBefore(
      harness.queries.contacts.findSourceContact as ReturnType<typeof vi.fn>,
    )
    expect(names(harness.attempted)).toEqual(['contacts.lockContactPairOrdered'])
  })

  it('returns the exact already-linked no-op without opening a unit of work', async () => {
    const harness = makeHarness({
      sources: { 'source-contact': source({ yandexDriverId: 'yandex-driver' }) },
    })

    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'requested-driver-id',
      mergedBy: 'system',
    })).resolves.toEqual({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'already_linked',
      contactId: 'source-contact',
      driverId: 'requested-driver-id',
    })
    expect(harness.queries.contacts.findSurvivorByYandexDriverId).toHaveBeenCalled()
    expect(names(harness.attempted)).toEqual(['contacts.lockContactPairOrdered'])
  })

  it('preserves contact-to-driver conflict and archive errors', async () => {
    const conflict = makeHarness({
      sources: { 'source-contact': source({ yandexDriverId: 'other-yandex-driver' }) },
    })
    await expect(conflict.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'system',
    })).rejects.toMatchObject({ code: 'CONTACT_LINKED_TO_OTHER_DRIVER' })

    const archived = makeHarness({
      sources: { 'source-contact': source({ isArchived: true }) },
    })
    await expect(archived.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'system',
    })).rejects.toMatchObject({ code: 'CONTACT_ARCHIVED' })
  })

  it('preserves contact-to-driver CONTACT_NOT_FOUND and survivor archive guards', async () => {
    const missingContact = makeHarness({ sources: { 'source-contact': null } })
    await expect(missingContact.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      code: 'CONTACT_NOT_FOUND',
      message: 'Contact source-contact not found',
    })
    expect(missingContact.queries.fleet.findDriverById).toHaveBeenCalled()

    const archivedSurvivor = makeHarness({
      survivorByYandexDriverId: survivor({ isArchived: true }),
    })
    await expect(archivedSurvivor.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      code: 'SURVIVOR_ARCHIVED',
      message: 'Survivor contact survivor-contact is archived',
    })
    expect(names(archivedSurvivor.attempted)).toEqual(['contacts.lockContactPairOrdered'])
  })

  it('rejects self merge before any lookup', async () => {
    const harness = makeHarness()
    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'same',
      targetId: 'same',
      mergedBy: 'system',
    })).rejects.toEqual(expect.objectContaining({
      name: 'MergeError',
      code: 'SELF_MERGE',
      message: 'Cannot merge contact into itself',
    }))
    expect(harness.queries.contacts.findSourceContact).not.toHaveBeenCalled()
  })

  it('preserves archived-source idempotency before source-driver and target checks', async () => {
    const harness = makeHarness({
      sources: {
        'source-contact': source({ isArchived: true, yandexDriverId: 'ignored-driver-link' }),
      },
      completedMerge: true,
    })
    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).resolves.toEqual({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'already_merged',
      sourceId: 'source-contact',
      targetId: 'target-contact',
    })
    expect(harness.queries.contacts.hasCompletedMerge).toHaveBeenCalledWith(
      'source-contact',
      'target-contact',
    )
    expect(harness.queries.contacts.findTargetContact).not.toHaveBeenCalled()
  })

  it('preserves missing-source, missing-target and non-idempotent archived-source errors', async () => {
    const missingSource = makeHarness({ sources: { 'source-contact': null } })
    await expect(missingSource.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      code: 'CONTACT_NOT_FOUND',
      message: 'Source contact source-contact not found',
    })

    const missingTarget = makeHarness({ targets: { 'target-contact': null } })
    await expect(missingTarget.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      code: 'CONTACT_NOT_FOUND',
      message: 'Target contact target-contact not found',
    })

    const archivedSource = makeHarness({
      sources: { 'source-contact': source({ isArchived: true }) },
      completedMerge: false,
    })
    await expect(archivedSource.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).rejects.toMatchObject({
      code: 'CONTACT_ARCHIVED',
      message: 'Source contact source-contact is archived',
    })
    expect(archivedSource.queries.contacts.findTargetContact).not.toHaveBeenCalled()
  })

  it('allows the survivor policy to preserve a source driver and still guards archived targets', async () => {
    const linkedSource = makeHarness({
      sources: { 'source-contact': source({ yandexDriverId: 'source-driver' }) },
    })
    await expect(linkedSource.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).resolves.toMatchObject({ status: 'contact_merged', survivorId: 'target-contact' })

    const archivedTarget = makeHarness({
      targets: { 'target-contact': survivor({ id: 'target-contact', isArchived: true }) },
    })
    await expect(archivedTarget.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })).rejects.toMatchObject({ code: 'SURVIVOR_ARCHIVED' })
    expect(names(archivedTarget.attempted)).toEqual(['contacts.lockContactPairOrdered'])
  })
})

describe('MergeContactsCommand.v1 ordered unit of work', () => {
  it('executes a simple link in exact order and logs only after commit', async () => {
    const harness = makeHarness()
    const result = await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'operator',
    })

    expect(result).toEqual({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'linked',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
    })
    expect(names(harness.committed)).toEqual([
      'contacts.lockContactPairOrdered',
      'contacts.linkContactToDriver',
      'messaging.attachUnlinkedContactChatsToDriver',
      'contacts.verifyOwnershipPostconditions',
    ])
    expect(harness.committed[1].args[0]).toEqual({
      contactId: 'source-contact',
      driverYandexId: 'yandex-driver',
      driverFullName: 'Driver Name',
      replaceDisplayName: true,
    })
    expect(harness.logs).toEqual([
      '[ContactMergeService] Simple link: contact=source-contact → driver=yandex-driver',
    ])
  })

  it('skips the Messaging write for a simple link whose source has no chats', async () => {
    const harness = makeHarness({
      sources: { 'source-contact': source({ chats: [] }) },
    })
    await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'system',
    })
    expect(names(harness.committed)).toEqual([
      'contacts.lockContactPairOrdered',
      'contacts.linkContactToDriver',
      'contacts.verifyOwnershipPostconditions',
    ])
  })

  it('executes driver merge statements, deduplication and snapshot in legacy order', async () => {
    const merged = source()
    const harness = makeHarness({
      sources: { 'source-contact': merged },
      survivorByYandexDriverId: survivor(),
    })
    const result = await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_driver',
      contactId: 'source-contact',
      driverId: 'driver-db-id',
      mergedBy: 'manager-1',
    })

    expect(names(harness.committed)).toEqual([
      'contacts.lockContactPairOrdered',
      'messaging.remapChatsToIdentity',
      'contacts.deleteDuplicateIdentities',
      'contacts.moveIdentitiesToContact',
      'contacts.repointIdentitiesToPhone',
      'contacts.deleteDuplicatePhones',
      'contacts.movePhonesToContact',
      'contacts.reconcilePrimaryPhonesAfterMove',
      'contacts.composeContactState',
      'messaging.moveChatsToDriverContact',
      'messaging.attachUnlinkedContactChatsToDriver',
      'work.moveTasksToContact',
      'calling.moveCallsToContact',
      'fleet.moveDriverProfilesToContact',
      'contacts.recordMerge',
      'contacts.archiveContact',
      'contacts.setMergedRedirect',
      'contacts.verifyOwnershipPostconditions',
    ])
    expect(harness.committed[0].args).toEqual(['source-contact', 'survivor-contact'])
    const record = harness.committed.find((call) => call.name === 'contacts.recordMerge')
    expect(record?.args[0]).toEqual(expect.objectContaining({
      id: 'generated-merge-id',
      survivorId: 'survivor-contact',
      mergedId: 'source-contact',
      mergedBy: 'manager-1',
      reason: 'yandex_link',
      driverYandexId: 'yandex-driver',
      snapshotBefore: expect.objectContaining({
        contact: {
          id: merged.id,
          displayName: merged.displayName,
          displayNameSource: merged.displayNameSource,
          masterSource: merged.masterSource,
          yandexDriverId: merged.yandexDriverId,
          mainDriverId: merged.mainDriverId,
          mainDriverSelection: merged.mainDriverSelection,
          mainDriverSelectedBy: merged.mainDriverSelectedBy,
          mainDriverSelectedAt: merged.mainDriverSelectedAt,
          primaryPhoneId: merged.primaryPhoneId,
          notes: merged.notes,
          tags: merged.tags,
          doNotMerge: merged.doNotMerge,
          customFields: merged.customFields,
        },
        phones: merged.phones,
        identities: merged.identities,
        chatIds: ['chat-1'],
        taskIds: ['task-1'],
        callIds: [],
        driverProfileIds: [],
      }),
      automated: false,
      evidenceRoots: [],
    }))
    expect(result).toMatchObject({
      contract: MERGE_CONTACTS_RESULT_V1,
      status: 'merged',
      mergeRecordId: 'generated-merge-id',
    })
    expect(harness.logs).toEqual([
      '[ContactMergeService] Full merge: merged=source-contact → survivor=survivor-contact '
      + 'driver=yandex-driver mergeRecord=generated-merge-id',
    ])
  })

  it('resolves a target driver inside the contact merge transaction at the legacy position', async () => {
    const harness = makeHarness({ targetDriverId: 'target-driver-db-id' })
    await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'manager-2',
    })

    expect(names(harness.committed)).toEqual([
      'contacts.lockContactPairOrdered',
      'messaging.remapChatsToIdentity',
      'contacts.deleteDuplicateIdentities',
      'contacts.moveIdentitiesToContact',
      'contacts.repointIdentitiesToPhone',
      'contacts.deleteDuplicatePhones',
      'contacts.movePhonesToContact',
      'contacts.reconcilePrimaryPhonesAfterMove',
      'contacts.composeContactState',
      'fleet.findDriverIdByYandexDriverId',
      'messaging.moveChatsToDriverContact',
      'work.moveTasksToContact',
      'calling.moveCallsToContact',
      'fleet.moveDriverProfilesToContact',
      'contacts.recordMerge',
      'contacts.archiveContact',
      'contacts.setMergedRedirect',
      'contacts.verifyOwnershipPostconditions',
    ])
    expect(harness.committed[10].args).toEqual([
      'source-contact',
      'target-contact',
      'target-driver-db-id',
    ])
    expect(harness.logs).toEqual([
      '[ContactMergeService] Contact merge: source=source-contact → target=target-contact '
      + 'mergeRecord=generated-merge-id',
    ])
  })

  it('moves contact chats without a Fleet lookup when the target has no driver', async () => {
    const harness = makeHarness({
      targets: {
        'target-contact': survivor({ id: 'target-contact', yandexDriverId: null }),
      },
    })
    await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })
    expect(names(harness.committed)).toContain('messaging.moveChatsToContact')
    expect(names(harness.committed)).not.toContain('fleet.findDriverIdByYandexDriverId')
  })

  it('moves losing Driver profiles through the Fleet owner and preserves them in recovery', async () => {
    const harness = makeHarness({
      sources: {
        'source-contact': source({
          yandexDriverId: 'source-yandex-driver',
          driverProfiles: [{ id: 'source-driver-profile' }],
        }),
      },
      targets: {
        'target-contact': survivor({ id: 'target-contact', yandexDriverId: null }),
      },
      targetDriverId: 'source-driver-db-id',
    })
    await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'manager',
    })

    expect(harness.committed.find(call => call.name === 'fleet.moveDriverProfilesToContact')?.args)
      .toEqual(['source-contact', 'target-contact'])
    expect(harness.committed.find(call => call.name === 'fleet.findDriverIdByYandexDriverId')?.args)
      .toEqual(['source-yandex-driver'])
    expect(harness.committed.find(call => call.name === 'contacts.recordMerge')?.args[0])
      .toEqual(expect.objectContaining({
        driverYandexId: 'source-yandex-driver',
        snapshotBefore: expect.objectContaining({ driverProfileIds: ['source-driver-profile'] }),
      }))
  })

  it('keeps the in-transaction Fleet lookup and contact-only move when the linked driver is missing', async () => {
    const harness = makeHarness({ targetDriverId: null })
    await harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system',
    })
    const operationNames = names(harness.committed)
    expect(operationNames).toContain('fleet.findDriverIdByYandexDriverId')
    expect(operationNames).toContain('messaging.moveChatsToContact')
    expect(operationNames).not.toContain('messaging.moveChatsToDriverContact')
    expect(operationNames.indexOf('fleet.findDriverIdByYandexDriverId')).toBeLessThan(
      operationNames.indexOf('messaging.moveChatsToContact'),
    )
  })

  it('revalidates automatic merge eligibility after locking and fails closed on substantive phone-only state', async () => {
    const harness = makeHarness({
      sources: { 'source-contact': source({ notes: 'left business state' }) },
      targets: { 'target-contact': survivor({ id: 'target-contact', tags: ['right-business-state'] }) },
    })
    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system:auto-merge',
      automation: {
        trustedUniqueCurrentPhone: true,
        phoneEvidenceRoot: 'provider-phone:+79990000000',
        confirmedPersonEvidenceRoots: [],
        normalizedVuEvidenceRoots: [],
      },
    })).rejects.toMatchObject({
      code: 'INVALID_MERGE_STATE',
      message: 'Automatic merge blocked after lock: substantive_phone_only',
    })
    expect(names(harness.committed)).toEqual([])
  })

  it('does not trust fabricated automatic evidence after the ownership lock', async () => {
    const shell = source({
      chats: [], tasks: [], calls: [], driverProfiles: [], driverConfirmations: [],
      notes: null, tags: [], customFields: {}, yandexDriverId: null,
    })
    const otherShell = survivor({
      id: 'target-contact', chats: [], tasks: [], calls: [], driverProfiles: [], driverConfirmations: [],
      notes: null, tags: [], customFields: {}, yandexDriverId: null, canonicalPinnedAt: null,
    })
    const harness = makeHarness({
      sources: { 'source-contact': shell },
      targets: { 'target-contact': otherShell },
    })
    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system:auto-merge',
      automation: {
        trustedUniqueCurrentPhone: true,
        phoneEvidenceRoot: 'fabricated-root',
        confirmedPersonEvidenceRoots: ['fabricated-confirmation'],
        normalizedVuEvidenceRoots: ['fabricated-vu'],
      },
    })).rejects.toMatchObject({
      code: 'INVALID_MERGE_STATE',
      message: 'Automatic merge blocked after lock: insufficient_evidence',
    })
    expect(names(harness.committed)).toEqual([])
    expect(names(harness.attempted)).toEqual([
      'contacts.lockContactPairOrdered', 'contacts.deriveAutomaticMergeEvidence',
    ])
  })

  it('uses persisted locked evidence for the approved channel-shell merge', async () => {
    const shell = source({
      chats: [], tasks: [], calls: [], driverProfiles: [], driverConfirmations: [],
      notes: null, tags: [], customFields: {}, yandexDriverId: null,
    })
    const otherShell = survivor({
      id: 'target-contact', chats: [], tasks: [], calls: [], driverProfiles: [], driverConfirmations: [],
      notes: null, tags: [], customFields: {}, yandexDriverId: null, canonicalPinnedAt: null,
    })
    const persistedEvidence = {
      trustedUniqueCurrentPhone: true,
      phoneEvidenceRoot: 'phone:+79990000000:provider:left|provider:right',
      confirmedPersonEvidenceRoots: [],
      normalizedVuEvidenceRoots: [],
    }
    const harness = makeHarness({
      sources: { 'source-contact': shell },
      targets: { 'target-contact': otherShell },
      automaticEvidence: persistedEvidence,
    })
    await expect(harness.handler({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: 'source-contact',
      targetId: 'target-contact',
      mergedBy: 'system:auto-merge',
      automation: {
        trustedUniqueCurrentPhone: false,
        phoneEvidenceRoot: null,
        confirmedPersonEvidenceRoots: [],
        normalizedVuEvidenceRoots: [],
      },
    })).resolves.toMatchObject({ status: 'contact_merged' })
    expect(harness.committed.find(call => call.name === 'contacts.recordMerge')?.args[0])
      .toEqual(expect.objectContaining({ automated: true, evidenceRoots: [persistedEvidence.phoneEvidenceRoot] }))
  })

  const simpleLinkSequence = [
    'contacts.lockContactPairOrdered',
    'contacts.linkContactToDriver',
    'messaging.attachUnlinkedContactChatsToDriver',
    'contacts.verifyOwnershipPostconditions',
  ]
  const driverMergeSequence = [
    'contacts.lockContactPairOrdered',
    'messaging.remapChatsToIdentity',
    'contacts.deleteDuplicateIdentities',
    'contacts.moveIdentitiesToContact',
    'contacts.repointIdentitiesToPhone',
    'contacts.deleteDuplicatePhones',
    'contacts.movePhonesToContact',
    'contacts.reconcilePrimaryPhonesAfterMove',
    'contacts.composeContactState',
    'messaging.moveChatsToDriverContact',
    'messaging.attachUnlinkedContactChatsToDriver',
    'work.moveTasksToContact',
    'calling.moveCallsToContact',
    'fleet.moveDriverProfilesToContact',
    'contacts.recordMerge',
    'contacts.archiveContact',
    'contacts.setMergedRedirect',
    'contacts.verifyOwnershipPostconditions',
  ]
  const manualMergeWithDriverSequence = [
    'contacts.lockContactPairOrdered',
    'messaging.remapChatsToIdentity',
    'contacts.deleteDuplicateIdentities',
    'contacts.moveIdentitiesToContact',
    'contacts.repointIdentitiesToPhone',
    'contacts.deleteDuplicatePhones',
    'contacts.movePhonesToContact',
    'contacts.reconcilePrimaryPhonesAfterMove',
    'contacts.composeContactState',
    'fleet.findDriverIdByYandexDriverId',
    'messaging.moveChatsToDriverContact',
    'work.moveTasksToContact',
    'calling.moveCallsToContact',
    'fleet.moveDriverProfilesToContact',
    'contacts.recordMerge',
    'contacts.archiveContact',
    'contacts.setMergedRedirect',
    'contacts.verifyOwnershipPostconditions',
  ]
  const manualMergeWithoutDriverSequence = [
    'contacts.lockContactPairOrdered',
    'messaging.remapChatsToIdentity',
    'contacts.deleteDuplicateIdentities',
    'contacts.moveIdentitiesToContact',
    'contacts.repointIdentitiesToPhone',
    'contacts.deleteDuplicatePhones',
    'contacts.movePhonesToContact',
    'contacts.reconcilePrimaryPhonesAfterMove',
    'contacts.composeContactState',
    'fleet.findDriverIdByYandexDriverId',
    'messaging.moveChatsToContact',
    'work.moveTasksToContact',
    'calling.moveCallsToContact',
    'fleet.moveDriverProfilesToContact',
    'contacts.recordMerge',
    'contacts.archiveContact',
    'contacts.setMergedRedirect',
    'contacts.verifyOwnershipPostconditions',
  ]
  const failureScenarios: Array<{
    flow: string
    options: HarnessOptions
    command: Record<string, string>
    sequence: string[]
  }> = [
    {
      flow: 'simple link',
      options: {},
      command: {
        contract: MERGE_CONTACTS_COMMAND_V1,
        operation: 'contact_to_driver',
        contactId: 'source-contact',
        driverId: 'driver-db-id',
        mergedBy: 'manager',
      },
      sequence: simpleLinkSequence,
    },
    {
      flow: 'driver full merge',
      options: { survivorByYandexDriverId: survivor() },
      command: {
        contract: MERGE_CONTACTS_COMMAND_V1,
        operation: 'contact_to_driver',
        contactId: 'source-contact',
        driverId: 'driver-db-id',
        mergedBy: 'manager',
      },
      sequence: driverMergeSequence,
    },
    {
      flow: 'manual merge with target driver',
      options: { targetDriverId: 'target-driver-db-id' },
      command: {
        contract: MERGE_CONTACTS_COMMAND_V1,
        operation: 'contact_to_contact',
        sourceId: 'source-contact',
        targetId: 'target-contact',
        mergedBy: 'manager',
      },
      sequence: manualMergeWithDriverSequence,
    },
    {
      flow: 'manual merge with missing target driver',
      options: { targetDriverId: null },
      command: {
        contract: MERGE_CONTACTS_COMMAND_V1,
        operation: 'contact_to_contact',
        sourceId: 'source-contact',
        targetId: 'target-contact',
        mergedBy: 'manager',
      },
      sequence: manualMergeWithoutDriverSequence,
    },
  ]
  const failureCases = failureScenarios.flatMap((scenario) =>
    scenario.sequence.map((failAt, index) => ({
      ...scenario,
      failAt,
      expectedAttemptedPrefix: scenario.sequence.slice(0, index + 1),
    })),
  )

  it.each(failureCases)(
    '$flow rolls back when $failAt fails',
    async ({ options, command, failAt, expectedAttemptedPrefix }) => {
      const harness = makeHarness({ ...options, failAt })
      let result: unknown
      await expect((async () => {
        result = await harness.handler(command)
      })()).rejects.toThrow(`injected failure: ${failAt}`)

      expect(result).toBeUndefined()
      expect(harness.committed).toEqual([])
      expect(harness.logs).toEqual([])
      expect(names(harness.attempted)).toEqual(expectedAttemptedPrefix)
    },
  )

  it('keeps MergeError as the exact legacy runtime error shape', () => {
    const error = new ContactMergeErrorV1('INVALID_MERGE_STATE', 'invalid state')
    expect(error).toBeInstanceOf(Error)
    expect(error).toMatchObject({ name: 'MergeError', code: 'INVALID_MERGE_STATE', message: 'invalid state' })
  })
})
