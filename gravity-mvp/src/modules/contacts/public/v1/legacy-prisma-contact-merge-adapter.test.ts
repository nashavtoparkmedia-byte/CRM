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
