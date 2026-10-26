import { describe, expect, test, vi } from 'vitest'

import { makeLegacyPrismaContactMergeRepositoriesV1 } from './legacy-prisma-contact-merge-adapter'

function phoneEvidence(root: string) {
  return {
    lifecycle: 'current',
    trust: 'provider_bound',
    freshness: 'fresh',
    resolutionState: 'unique',
    evidenceRoot: root,
  }
}

function transactionHarness(ownerIds = ['left', 'right']) {
  const contacts = [
    {
      id: 'left',
      customFields: { phoneEvidenceByPhoneId: { 'phone-left': phoneEvidence('provider:left') } },
      phones: [{ id: 'phone-left', phone: '+79990000000', isActive: true, verifiedAt: new Date() }],
      driverProfiles: [],
    },
    {
      id: 'right',
      customFields: { phoneEvidenceByPhoneId: { 'phone-right': phoneEvidence('provider:right') } },
      phones: [{ id: 'phone-right', phone: '+79990000000', isActive: true, verifiedAt: new Date() }],
      driverProfiles: [],
    },
  ]
  const owners = ownerIds.map((contactId, index) => ({
    id: `owner-${index}`,
    contactId,
    phone: '+79990000000',
    isActive: true,
    verifiedAt: new Date(),
    contact: {
      customFields: {
        phoneEvidenceByPhoneId: {
          [`owner-${index}`]: phoneEvidence(`provider:${contactId}`),
        },
      },
    },
  }))
  const transaction = {
    contact: { findMany: vi.fn(async () => contacts) },
    contactPhone: { findMany: vi.fn(async () => owners) },
    driver: { findMany: vi.fn(async () => []) },
  }
  return makeLegacyPrismaContactMergeRepositoriesV1(transaction as never).contacts
}

describe('persisted automatic merge evidence', () => {
  test('derives an approved two-Contact phone root from current trusted persisted rows', async () => {
    await expect(transactionHarness().deriveAutomaticMergeEvidence('left', 'right')).resolves.toEqual({
      trustedUniqueCurrentPhone: true,
      phoneEvidenceRoot: 'phone:+79990000000:provider:left|provider:right',
      confirmedPersonEvidenceRoots: [],
      confirmedPersonKeys: [],
      normalizedVuEvidenceRoots: [],
    })
  })

  test('a third active owner makes the same phone ineligible for automatic merge', async () => {
    await expect(transactionHarness(['left', 'right', 'third'])
      .deriveAutomaticMergeEvidence('left', 'right')).resolves.toMatchObject({
      trustedUniqueCurrentPhone: false,
      phoneEvidenceRoot: null,
    })
  })

  test('a third confirmed-person owner makes the shared confirmation ineligible', async () => {
    const confirmation = (contactId: string) => ({
      status: 'confirmed',
      profileClusterKey: 'vu:shared',
      evidenceRoot: `operator:${contactId}:vu:shared`,
    })
    const pair = ['left', 'right'].map(id => ({
      id,
      customFields: {
        confirmedDriverClusterKeys: ['vu:shared'],
        driverConfirmations: [confirmation(id)],
      },
      phones: [],
      driverProfiles: [],
    }))
    const owners = [...pair, {
      id: 'third',
      customFields: {
        confirmedDriverClusterKeys: ['vu:shared'],
        driverConfirmations: [confirmation('third')],
      },
    }]
    const transaction = {
      contact: {
        findMany: vi.fn(async (query: { where: { id?: unknown } }) => (
          query.where.id ? pair : owners
        )),
      },
      contactPhone: { findMany: vi.fn(async () => []) },
      driver: { findMany: vi.fn(async () => []) },
    }
    await expect(makeLegacyPrismaContactMergeRepositoriesV1(transaction as never).contacts
      .deriveAutomaticMergeEvidence('left', 'right')).resolves.toMatchObject({
      confirmedPersonEvidenceRoots: [],
    })
  })

  test('a third fresh normalized-VU owner makes the shared VU ineligible', async () => {
    const profile = (contactId: string) => ({
      externalPersonKey: 'vu:shared',
      personKeyType: 'normalized_vu',
      personResolutionStatus: 'vu_clustered',
      customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId,
    })
    const contacts = ['left', 'right'].map(id => ({
      id,
      customFields: {},
      phones: [],
      driverProfiles: [profile(id)],
    }))
    const transaction = {
      contact: { findMany: vi.fn(async () => contacts) },
      contactPhone: { findMany: vi.fn(async () => []) },
      driver: { findMany: vi.fn(async () => ['left', 'right', 'third'].map(profile)) },
    }
    await expect(makeLegacyPrismaContactMergeRepositoriesV1(transaction as never).contacts
      .deriveAutomaticMergeEvidence('left', 'right')).resolves.toMatchObject({
      normalizedVuEvidenceRoots: [],
    })
  })
})

describe('merge policy snapshot inputs', () => {
  test('retains persisted identity sources and Fleet conflict state on adapter reads', async () => {
    const findUnique = vi.fn(async () => ({
      id: 'manual-contact',
      displayName: 'Curated name',
      displayNameSource: 'manual',
      masterSource: 'manual',
      yandexDriverId: null,
      mainDriverId: null,
      mainDriverSelection: 'auto',
      mainDriverSelectedBy: null,
      mainDriverSelectedAt: null,
      primaryPhoneId: null,
      notes: null,
      customFields: {},
      tags: [],
      isArchived: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      phones: [],
      identities: [],
      chats: [],
      tasks: [],
      calls: [],
      driverProfiles: [{ id: 'driver-conflict', personResolutionStatus: 'conflict' }],
      driver: null,
      mainDriver: null,
    }))
    const transaction = {
      contact: { findUnique },
    }
    const repositories = makeLegacyPrismaContactMergeRepositoriesV1(transaction as never)

    await expect(repositories.contacts.findSourceContact('manual-contact')).resolves.toMatchObject({
      id: 'manual-contact',
      displayNameSource: 'manual',
      masterSource: 'manual',
      driverProfiles: [{ id: 'driver-conflict', personResolutionStatus: 'conflict' }],
    })
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'manual-contact' },
      include: expect.objectContaining({
        driverProfiles: { select: { id: true, personResolutionStatus: true } },
        driver: { select: { id: true, personResolutionStatus: true } },
        mainDriver: { select: { id: true, personResolutionStatus: true } },
      }),
    })
  })
})

describe('merge composes the communication policy deny-wins', () => {
  type Row = { denyAll: boolean; denyMessage: boolean; denyVoice: boolean; version: number }
  function policyHarness(rows: Record<string, Row | null>, updateCount = 1) {
    const created: Array<Record<string, unknown>> = []
    const updated: Array<{ where: Record<string, unknown>; data: Record<string, unknown> }> = []
    const events: Array<Record<string, unknown>> = []
    const transaction = {
      contactCommunicationPolicy: {
        findUnique: vi.fn(async ({ where }: { where: { contactId: string } }) => rows[where.contactId] ?? null),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { created.push(data); return data }),
        updateMany: vi.fn(async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
          updated.push(input)
          return { count: updateCount }
        }),
      },
      contactCommunicationPolicyEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data }),
      },
      contactMerge: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: data.id })),
      },
    }
    return {
      contacts: makeLegacyPrismaContactMergeRepositoriesV1(transaction as never).contacts,
      transaction,
      created,
      updated,
      events,
    }
  }
  const merge = { mergeId: 'merge-1', actor: 'manager-1' }

  test('writes nothing when neither side has a policy', async () => {
    const harness = policyHarness({ source: null, survivor: null })
    await expect(harness.contacts.composeCommunicationPolicy('source', 'survivor', merge)).resolves.toEqual({
      sourceBefore: null, survivorBefore: null, composed: null,
    })
    expect(harness.created).toEqual([])
    expect(harness.updated).toEqual([])
    expect(harness.events).toEqual([])
  })

  test('false+true, true+false and true+true all compose to true at the survivor next version with one merge event', async () => {
    const harness = policyHarness({
      source: { denyAll: false, denyMessage: true, denyVoice: true, version: 2 },
      survivor: { denyAll: false, denyMessage: false, denyVoice: true, version: 4 },
    })
    await expect(harness.contacts.composeCommunicationPolicy('source', 'survivor', merge)).resolves.toEqual({
      sourceBefore: { denyAll: false, denyMessage: true, denyVoice: true, version: 2 },
      survivorBefore: { denyAll: false, denyMessage: false, denyVoice: true, version: 4 },
      composed: { denyAll: false, denyMessage: true, denyVoice: true, version: 5 },
    })
    expect(harness.created).toEqual([])
    expect(harness.updated).toEqual([{
      where: { contactId: 'survivor', version: 4 },
      data: { denyAll: false, denyMessage: true, denyVoice: true, version: 5, updatedBy: 'manager-1' },
    }])
    expect(harness.events).toEqual([expect.objectContaining({
      contactId: 'survivor', cause: 'merge', version: 5, previousVersion: 4,
      beforeDenyAll: false, beforeDenyMessage: false, beforeDenyVoice: true,
      afterDenyAll: false, afterDenyMessage: true, afterDenyVoice: true,
      actor: 'manager-1', reason: 'contact_merge:merge-1', mergeId: 'merge-1', sourceContactId: 'source',
      mutationRequestId: null, requestDigest: null,
    })])
    // The merged-away Contact's own policy row is never written.
    expect(harness.transaction.contactCommunicationPolicy.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contactId: 'source' }) }),
    )
  })

  test('creates the survivor row at version 1 when only the source carried a restriction', async () => {
    const harness = policyHarness({ source: { denyAll: true, denyMessage: false, denyVoice: false, version: 1 }, survivor: null })
    await expect(harness.contacts.composeCommunicationPolicy('source', 'survivor', merge)).resolves.toMatchObject({
      composed: { denyAll: true, denyMessage: false, denyVoice: false, version: 1 },
    })
    expect(harness.created).toEqual([{ contactId: 'survivor', denyAll: true, denyMessage: false, denyVoice: false, version: 1, updatedBy: 'manager-1' }])
    expect(harness.events[0]).toMatchObject({ version: 1, previousVersion: null, beforeDenyAll: null, afterDenyAll: true })
  })

  test('fails closed when the survivor row moved under the merge', async () => {
    const harness = policyHarness({ source: null, survivor: { denyAll: false, denyMessage: false, denyVoice: true, version: 4 } }, 0)
    await expect(harness.contacts.composeCommunicationPolicy('source', 'survivor', merge)).rejects.toThrow(/no longer current/u)
    expect(harness.events).toEqual([])
  })

  test('recordMerge stores the policy evidence next to the merge recovery metadata', async () => {
    const harness = policyHarness({})
    const communicationPolicy = {
      sourceBefore: { denyAll: true, denyMessage: false, denyVoice: false, version: 1 },
      survivorBefore: null,
      composed: { denyAll: true, denyMessage: false, denyVoice: false, version: 1 },
    }
    await harness.contacts.recordMerge({
      id: 'merge-1', survivorId: 'survivor', mergedId: 'source', mergedBy: 'manager-1', reason: 'manual', driverYandexId: null,
      snapshotBefore: { contact: { id: 'source' } } as never, survivorEvaluation: {}, automated: false, evidenceRoots: [],
      communicationPolicy,
    })
    const stored = harness.transaction.contactMerge.create.mock.calls[0][0] as { data: { snapshotBefore: { _merge: Record<string, unknown> } } }
    expect(stored.data.snapshotBefore._merge).toEqual({
      automated: false, evidenceRoots: [], survivorEvaluation: {}, recoveryState: 'clear', communicationPolicy,
    })
  })
})
