import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  queryRaw: vi.fn(),
  ownershipAdmission: vi.fn(),
  driverFindUnique: vi.fn(),
  driverFindFirst: vi.fn(),
  driverFindMany: vi.fn(),
  driverUpdate: vi.fn(),
  driverCreate: vi.fn(),
  driverUpdateMany: vi.fn(),
  contactFindUnique: vi.fn(),
  reconcile: vi.fn(),
  persistClusterConflict: vi.fn(),
  persistStandaloneConflict: vi.fn(),
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    $transaction: vi.fn(async (operation: (transaction: unknown) => unknown) => operation({
      $queryRaw: mocks.queryRaw,
      driver: {
        findUnique: mocks.driverFindUnique,
        findFirst: mocks.driverFindFirst,
        findMany: mocks.driverFindMany,
        update: mocks.driverUpdate,
        create: mocks.driverCreate,
        updateMany: mocks.driverUpdateMany,
      },
      contact: { findUnique: mocks.contactFindUnique },
    })),
  },
}))

vi.mock('@/modules/contacts/public/v1', () => ({
  persistDriverClusterContradictionV1: mocks.persistStandaloneConflict,
  runDriverClusterContactOwnershipV1: async (work: (capability: unknown) => unknown) => {
    await mocks.ownershipAdmission()
    return work({
      reconcile: mocks.reconcile,
      persistContradiction: mocks.persistClusterConflict,
    })
  },
}))

import {
  reconcileClusters,
  upsertObservation,
  type YandexFleetProfileObservationV1,
} from '../../internal/legacy-prisma-yandex-fleet-reconciler-adapter'

function observation(overrides: Partial<YandexFleetProfileObservationV1> = {}): YandexFleetProfileObservationV1 {
  return {
    externalParkId: 'park-a',
    localParkId: 'local-a',
    sourceConnectionId: 'connection-a',
    externalDriverProfileId: 'profile-a',
    fullName: 'Driver A',
    phones: ['+79990000001'],
    rawPhones: ['+7 999 000-00-01'],
    rawVu: '12 34 567890',
    normalizedVu: '1234567890',
    legalRole: 'driver',
    workStatus: 'working',
    currentStatus: 'online',
    city: 'Москва',
    profileType: 'staff',
    sourceDates: {},
    observedAt: new Date('2026-09-02T00:00:00.000Z'),
    rawMetadata: {},
    evidenceRoot: 'yandex:park-a:profile-a:current',
    ...overrides,
  }
}

describe('durable multi-park reconciliation context', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.queryRaw.mockResolvedValue([])
    mocks.ownershipAdmission.mockResolvedValue(undefined)
    mocks.persistClusterConflict.mockResolvedValue(undefined)
    mocks.driverUpdateMany.mockResolvedValue({ count: 0 })
  })

  test('loads a failed-park same-VU profile and defers an exact Contact pair to locked Contacts policy', async () => {
    mocks.driverFindMany.mockResolvedValueOnce([
      {
        id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
        sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
        licenseNumber: '12 34 567890', customFields: {
          fleetSource: { sourceFreshness: 'fresh', sourceState: 'current', sourcePhones: ['+79990000001'] },
        }, contactId: null, personResolutionStatus: 'vu_observed',
      },
      {
        id: 'driver-b', externalParkId: 'park-b', externalDriverProfileId: 'profile-b',
        sourceConnectionId: 'connection-b', fullName: 'Driver B', phone: '+79990000002',
        licenseNumber: '12 34 567890', customFields: {
          fleetSource: {
            sourceFreshness: 'stale', sourceState: 'stale', sourcePhones: ['+79990000002'],
            lastObservedAt: '2026-09-01T00:00:00.000Z',
          },
        }, contactId: 'contact-a', personResolutionStatus: 'operator_confirmed',
      },
    ])
    mocks.reconcile.mockResolvedValueOnce({ status: 'link', contactId: 'contact-b', basis: 'unique_phone' })

    const result = await reconcileClusters([{ driverId: 'driver-a', observation: observation() }])

    expect(mocks.driverFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { externalPersonKey: 'vu:1234567890' },
    }))
    expect(mocks.persistClusterConflict).not.toHaveBeenCalled()
    expect(mocks.driverUpdateMany).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({
      contactId: null,
      contactMergeCandidateIds: ['contact-a', 'contact-b'],
      profileIds: ['driver-a', 'driver-b'],
      warnings: ['contact_auto_merge_candidate'],
    })
  })

  test('re-reads a phone dispute only after CNT1 admission and does not link', async () => {
    let decision: { status: 'link'; contactId: string; basis: 'unique_phone' } | { status: 'conflict'; contactIds: string[] } = {
      status: 'link', contactId: 'contact-a', basis: 'unique_phone',
    }
    mocks.ownershipAdmission.mockImplementationOnce(async () => {
      decision = { status: 'conflict', contactIds: ['contact-a', 'contact-b'] }
    })
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockImplementationOnce(async () => decision)

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.ownershipAdmission.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.reconcile.mock.invocationCallOrder[0])
    expect(mocks.driverUpdateMany).not.toHaveBeenCalled()
    expect(mocks.persistClusterConflict).not.toHaveBeenCalled()
    expect(result[0]).toMatchObject({
      contactId: null,
      contactMergeCandidateIds: ['contact-a', 'contact-b'],
      warnings: ['contact_auto_merge_candidate'],
    })
  })

  test('persists a contradiction rather than proposing automation for more than two Contacts', async () => {
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockResolvedValueOnce({
      status: 'conflict',
      contactIds: ['contact-c', 'contact-a', 'contact-b'],
    })

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.persistClusterConflict).toHaveBeenCalledWith(expect.objectContaining({
      contactIds: ['contact-c', 'contact-a', 'contact-b'],
    }))
    expect(result[0]).toMatchObject({
      contactMergeCandidateIds: [],
      warnings: ['contact_phone_ambiguity'],
    })
  })

  test('uses the operator confirmation observed after CNT1 admission', async () => {
    let confirmedContactId = 'contact-old'
    mocks.ownershipAdmission.mockImplementationOnce(async () => {
      confirmedContactId = 'contact-new'
    })
    mocks.driverFindMany.mockResolvedValueOnce([{
      id: 'driver-a', externalParkId: 'park-a', externalDriverProfileId: 'profile-a',
      sourceConnectionId: 'connection-a', fullName: 'Driver A', phone: '+79990000001',
      licenseNumber: null, customFields: { fleetSource: { sourceFreshness: 'fresh' } },
      contactId: null, personResolutionStatus: 'unlinked',
    }])
    mocks.reconcile.mockImplementationOnce(async () => ({
      status: 'link', contactId: confirmedContactId, basis: 'operator_confirmation',
    }))
    mocks.contactFindUnique.mockResolvedValue({ isArchived: false, customFields: {} })

    const result = await reconcileClusters([{
      driverId: 'driver-a',
      observation: observation({ normalizedVu: null, rawVu: null }),
    }])

    expect(mocks.driverUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contactId: 'contact-new', personResolutionStatus: 'operator_confirmed' }),
    }))
    expect(result[0].contactId).toBe('contact-new')
  })

  test('an older pre-lock observation cannot overwrite newer profile evidence or trigger a stale cluster decision', async () => {
    mocks.driverFindUnique.mockResolvedValueOnce({
      id: 'driver-a',
      contactId: 'contact-new',
      yandexDriverId: 'qualified-a',
      licenseNumber: '1234567890',
      customFields: {
        fleetSource: {
          lastObservedAt: '2026-09-02T02:00:00.000Z',
          sourceFreshness: 'fresh',
          sourceState: 'current',
        },
      },
    })

    await expect(upsertObservation(observation({
      observedAt: new Date('2026-09-02T01:00:00.000Z'),
      phones: ['+79990000009'],
      normalizedVu: '9999999999',
      rawVu: '9999999999',
    }), 2)).resolves.toBeNull()

    expect(mocks.driverUpdate).not.toHaveBeenCalled()
    expect(mocks.driverCreate).not.toHaveBeenCalled()
    expect(mocks.reconcile).not.toHaveBeenCalled()
  })
})
