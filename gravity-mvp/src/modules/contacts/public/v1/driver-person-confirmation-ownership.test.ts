import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runOwnership: vi.fn(),
  prismaContactFindMany: vi.fn(),
  prismaContactPhoneFindMany: vi.fn(),
  contactFindUnique: vi.fn(),
  contactFindMany: vi.fn(),
  contactUpdate: vi.fn(),
  contactPhoneFindMany: vi.fn(),
  lockOwnershipRows: vi.fn(),
  lockHeld: false,
  releaseWaiters: [] as Array<() => void>,
}))

vi.mock('@/lib/prisma', () => ({
  prisma: {
    contact: { findMany: mocks.prismaContactFindMany },
    contactPhone: { findMany: mocks.prismaContactPhoneFindMany },
  },
}))
vi.mock('../../internal/contact-ownership-coordinator', () => ({
  lockContactOwnershipRows: mocks.lockOwnershipRows,
  runContactOwnershipTransaction: mocks.runOwnership,
}))

import {
  confirmDriverPersonV1,
  DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1,
  getConfirmedContactForDriverClusterV1,
  isContactConfirmedMainDriverV1,
  persistDriverClusterContradictionV1,
  reconcileDriverClusterContactV1,
  runDriverClusterContactOwnershipV1,
} from './driver-person-confirmation'

function attemptConcurrentOwnershipMutation(): Promise<void> {
  if (!mocks.lockHeld) return Promise.resolve()
  return new Promise(resolve => mocks.releaseWaiters.push(resolve))
}

describe('Driver cluster CNT1 ownership lifetime', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.lockHeld = false
    mocks.releaseWaiters = []
    mocks.runOwnership.mockImplementation(async (
      work: (transaction: unknown) => Promise<unknown>,
    ) => {
      mocks.lockHeld = true
      try {
        return await work({
          contact: {
            findUnique: mocks.contactFindUnique,
            findMany: mocks.contactFindMany,
            update: mocks.contactUpdate,
          },
          contactPhone: { findMany: mocks.contactPhoneFindMany },
        })
      } finally {
        mocks.lockHeld = false
        for (const release of mocks.releaseWaiters.splice(0)) release()
      }
    })
  })

  test('holds CNT1 beyond the former 10-second boundary until Fleet commits', async () => {
    vi.useFakeTimers()
    try {
      let finishFleet!: () => void
      const fleet = new Promise<void>(resolve => { finishFleet = resolve })
      const operation = runDriverClusterContactOwnershipV1(async () => fleet)
      await Promise.resolve()

      let concurrentMutationCompleted = false
      const concurrentMutation = attemptConcurrentOwnershipMutation()
        .then(() => { concurrentMutationCompleted = true })
      await vi.advanceTimersByTimeAsync(10_001)

      expect(concurrentMutationCompleted).toBe(false)
      expect(mocks.runOwnership).toHaveBeenCalledWith(expect.any(Function), {
        transactionTimeoutMs: DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1,
        maxWaitMs: 2_000,
      })
      expect(DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1).toBeGreaterThan(17_000)

      finishFleet()
      await operation
      await concurrentMutation
      expect(concurrentMutationCompleted).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  test('releases CNT1 only after Fleet rollback is observed', async () => {
    let rejectFleet!: (error: Error) => void
    const fleet = new Promise<void>((_resolve, reject) => { rejectFleet = reject })
    const operation = runDriverClusterContactOwnershipV1(async () => fleet)
    await Promise.resolve()
    let concurrentMutationCompleted = false
    const concurrentMutation = attemptConcurrentOwnershipMutation()
      .then(() => { concurrentMutationCompleted = true })

    rejectFleet(new Error('fleet rollback'))
    await expect(operation).rejects.toThrow('fleet rollback')
    await concurrentMutation
    expect(concurrentMutationCompleted).toBe(true)
  })

  test('persists a delayed Fleet contradiction on the current canonical Contact', async () => {
    mocks.contactFindUnique
      .mockResolvedValueOnce({
        id: 'merged-contact',
        isArchived: true,
        customFields: { mergedIntoContactId: 'canonical-contact' },
      })
      .mockResolvedValueOnce({
        id: 'canonical-contact',
        isArchived: false,
        customFields: { existingBusinessField: 'preserved' },
      })
    mocks.contactUpdate.mockResolvedValue({ id: 'canonical-contact' })

    await persistDriverClusterContradictionV1({
      profileClusterKey: 'vu:1234567890',
      contactIds: ['merged-contact'],
      driverIds: ['driver-a'],
      evidenceRoot: 'fleet:contradiction',
    })

    expect(mocks.lockOwnershipRows).toHaveBeenCalledWith(expect.anything(), {
      contactIds: ['merged-contact'],
    })
    expect(mocks.contactUpdate).toHaveBeenCalledWith({
      where: { id: 'canonical-contact' },
      data: {
        customFields: expect.objectContaining({
          existingBusinessField: 'preserved',
          identityConflicts: [expect.objectContaining({
            conflictType: 'fleet_authoritative_person_contradiction',
            otherContactId: null,
            evidenceRoot: 'fleet:contradiction',
            details: {
              profileClusterKey: 'vu:1234567890',
              driverIds: ['driver-a'],
              contactIds: ['canonical-contact'],
            },
            status: 'open',
          })],
        }),
      },
    })
  })

  test('rejects malformed confirmation before opening an ownership transaction', async () => {
    mocks.runOwnership.mockClear()
    await expect(confirmDriverPersonV1({
      contract: 'contacts.ConfirmDriverPersonCommand.v1',
      contactId: 'contact-1',
      profileClusterKey: 'cluster-1',
      representativeDriverId: 'driver-1',
      confirmedBy: 'operator-1',
      confirmationBasis: ['vu'],
      searchInput: '1234567890',
      evidenceSnapshot: { profiles: [], warnings: [] },
    })).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
    expect(mocks.runOwnership).not.toHaveBeenCalled()
  })

  test.each([
    ['a representative outside the evidence cluster', {
      ...confirmationCommand('contact-1'),
      representativeDriverId: 'forged-driver',
    }],
    ['a cluster key outside the supplied evidence', {
      ...confirmationCommand('contact-1'),
      profileClusterKey: 'vu:forged-cluster',
    }],
    ['stale confirmation evidence', {
      ...confirmationCommand('contact-1'),
      evidenceSnapshot: { profiles: [confirmationEvidence('driver-a', 'stale')], warnings: [] },
    }],
  ])('rejects %s before opening an ownership transaction', async (_label, command) => {
    await expect(confirmDriverPersonV1(command)).rejects.toMatchObject({ code: 'INVALID_CONTRACT' })
    expect(mocks.runOwnership).not.toHaveBeenCalled()
    expect(mocks.contactUpdate).not.toHaveBeenCalled()
  })

  test('rejects malformed reconciliation at the ownership capability before owner reads', async () => {
    await expect(runDriverClusterContactOwnershipV1(capability => capability.reconcile({
      contract: 'contacts.ReconcileDriverClusterCommand.v2',
      profileClusterKey: 'cluster-1',
      profiles: [],
      unknown: true,
    } as never))).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTRACT_VERSION' })

    expect(mocks.contactFindMany).not.toHaveBeenCalled()
    expect(mocks.contactPhoneFindMany).not.toHaveBeenCalled()
  })

  test('keeps an exact two-Contact claim pair eligible for reconciliation', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-b',
      isArchived: false,
      customFields: {},
    })
    mocks.contactFindMany.mockResolvedValue([{
      id: 'contact-a',
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [{
          id: 'confirmation-a',
          profileClusterKey: 'vu:1234567890',
          status: 'confirmed',
        }],
      },
    }])
    mocks.contactUpdate.mockResolvedValue({ id: 'contact-b' })

    const result = await confirmDriverPersonV1(confirmationCommand('contact-b'))

    expect(result).toMatchObject({
      status: 'needs_reconciliation',
      contactId: 'contact-b',
      mergeCandidateContactId: 'contact-a',
    })
    const update = mocks.contactUpdate.mock.calls[0]?.[0]
    expect(update.data.customFields).toMatchObject({
      confirmedDriverClusterKeys: ['vu:1234567890'],
      driverConfirmations: [expect.objectContaining({
        profileClusterKey: 'vu:1234567890',
        status: 'needs_reconciliation',
        reconciliationContactId: 'contact-a',
      })],
    })
    expect(update.data.customFields).not.toHaveProperty('identityConflicts')
    expect(update.data).not.toHaveProperty('mainDriverId')
  })

  test('persists a contradiction without replacing a different active person on the same Contact', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-a',
      isArchived: false,
      customFields: {
        confirmedDriverClusterKeys: ['vu:person-x'],
        driverConfirmations: [{
          id: 'confirmation-x',
          profileClusterKey: 'vu:person-x',
          representativeDriverId: 'driver-x',
          status: 'confirmed',
          confirmedBy: 'operator-original',
          confirmationBasis: 'vu',
          searchInput: 'person-x',
          evidenceRoot: 'operator-confirmation:contact-a:vu:person-x',
          evidenceSnapshot: { profiles: [{ driverId: 'driver-x' }], warnings: [] },
          confirmedAt: '2026-09-01T00:00:00.000Z',
          lastReconciledAt: '2026-09-01T00:00:00.000Z',
          reconciliationContactId: null,
        }],
      },
    })
    mocks.contactUpdate.mockResolvedValue({ id: 'contact-a' })

    const result = await confirmDriverPersonV1({
      ...confirmationCommand('contact-a'),
      profileClusterKey: 'vu:person-y',
      representativeDriverId: 'driver-y',
      evidenceSnapshot: {
        profiles: [{ ...confirmationEvidence('driver-y'), normalizedVu: 'person-y' }],
        warnings: [],
      },
    })

    expect(result).toMatchObject({
      status: 'contradiction',
      contactId: 'contact-a',
      confirmationId: 'confirmation-x',
      profileClusterKey: 'vu:person-y',
      conflictingContactIds: ['contact-a'],
    })
    expect(mocks.contactFindMany).not.toHaveBeenCalled()
    const update = mocks.contactUpdate.mock.calls[0]?.[0]
    expect(update.data.customFields).toMatchObject({
      confirmedDriverClusterKeys: ['vu:person-x'],
      driverConfirmations: [expect.objectContaining({
        id: 'confirmation-x',
        profileClusterKey: 'vu:person-x',
        representativeDriverId: 'driver-x',
        status: 'confirmed',
      })],
      identityConflicts: [expect.objectContaining({
        conflictType: 'confirmed_driver_cluster_contradiction',
        otherContactId: null,
        evidenceRoot: 'operator-confirmation:contact-a:vu:person-y',
        details: {
          requestedProfileClusterKey: 'vu:person-y',
          representativeDriverId: 'driver-y',
          existingProfileClusterKeys: ['vu:person-x'],
          existingRepresentativeDriverIds: ['driver-x'],
        },
        status: 'open',
      })],
    })
    expect(update.data).not.toHaveProperty('mainDriverId')
    expect(update.data).not.toHaveProperty('mainDriverSelection')
    expect(update.data).not.toHaveProperty('mainDriverSelectedBy')
  })

  test('counts a pending pair claim so a third Contact persists a contradiction', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-c',
      isArchived: false,
      customFields: {},
    })
    mocks.contactFindMany.mockResolvedValue([
      {
        id: 'contact-a',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-a',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
          }],
        },
      },
      {
        id: 'contact-b',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-b',
            profileClusterKey: 'vu:1234567890',
            status: 'needs_reconciliation',
            reconciliationContactId: 'contact-a',
          }],
        },
      },
    ])
    mocks.contactUpdate.mockResolvedValue({ id: 'contact-c' })

    const result = await confirmDriverPersonV1(confirmationCommand('contact-c'))

    expect(result).toMatchObject({
      status: 'contradiction',
      contactId: 'contact-c',
      conflictingContactIds: ['contact-a', 'contact-b'],
    })
    expect(result).not.toHaveProperty('mergeCandidateContactId')
    const update = mocks.contactUpdate.mock.calls[0]?.[0]
    expect(update.data.customFields).toMatchObject({
      confirmedDriverClusterKeys: [],
      driverConfirmations: [expect.objectContaining({
        profileClusterKey: 'vu:1234567890',
        status: 'contradicted',
        reconciliationContactId: null,
      })],
      identityConflicts: [expect.objectContaining({
        conflictType: 'confirmed_driver_cluster_contradiction',
        status: 'open',
        details: expect.objectContaining({
          profileClusterKey: 'vu:1234567890',
          conflictingContactIds: ['contact-a', 'contact-b'],
        }),
      })],
    })
    expect(update.data).not.toHaveProperty('mainDriverId')
  })

  test('does not downgrade the confirmed anchor when its exact pending counterpart is reconfirmed', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-a',
      isArchived: false,
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [{
          id: 'confirmation-a',
          profileClusterKey: 'vu:1234567890',
          representativeDriverId: 'driver-a',
          status: 'confirmed',
          confirmedBy: 'operator-original',
          confirmationBasis: 'vu',
          searchInput: '1234567890',
          evidenceRoot: 'operator-confirmation:contact-a:vu:1234567890',
          evidenceSnapshot: { profiles: [], warnings: [] },
          confirmedAt: '2026-09-01T00:00:00.000Z',
          lastReconciledAt: '2026-09-01T00:00:00.000Z',
          reconciliationContactId: null,
        }],
      },
    })
    mocks.contactFindMany.mockResolvedValue([{
      id: 'contact-b',
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [{
          id: 'confirmation-b',
          profileClusterKey: 'vu:1234567890',
          status: 'needs_reconciliation',
          reconciliationContactId: 'contact-a',
        }],
      },
    }])
    mocks.contactUpdate.mockResolvedValue({ id: 'contact-a' })

    const result = await confirmDriverPersonV1(confirmationCommand('contact-a'))

    expect(result).toMatchObject({ status: 'already_confirmed', contactId: 'contact-a' })
    expect(result).not.toHaveProperty('mergeCandidateContactId')
    const update = mocks.contactUpdate.mock.calls[0]?.[0]
    expect(update.data.customFields.driverConfirmations).toEqual([
      expect.objectContaining({
        id: 'confirmation-a',
        status: 'confirmed',
        reconciliationContactId: null,
      }),
    ])
    expect(update.data).not.toHaveProperty('mainDriverId')
    expect(update.data).not.toHaveProperty('mainDriverSelection')
  })

  test('preserves an existing confirmed anchor when multiple active claimants create a contradiction', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-a',
      isArchived: false,
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [{
          id: 'confirmation-a',
          profileClusterKey: 'vu:1234567890',
          representativeDriverId: 'driver-original',
          status: 'confirmed',
          confirmedBy: 'operator-original',
          confirmationBasis: 'vu',
          searchInput: 'original-search',
          evidenceRoot: 'operator-confirmation:contact-a:vu:1234567890',
          evidenceSnapshot: { profiles: [{ driverId: 'driver-original' }], warnings: [] },
          confirmedAt: '2026-09-01T00:00:00.000Z',
          lastReconciledAt: '2026-09-01T00:00:00.000Z',
          reconciliationContactId: null,
        }],
      },
    })
    mocks.contactFindMany.mockResolvedValue([
      {
        id: 'contact-b',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-b',
            profileClusterKey: 'vu:1234567890',
            status: 'needs_reconciliation',
            reconciliationContactId: 'contact-a',
          }],
        },
      },
      {
        id: 'contact-c',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-c',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
          }],
        },
      },
    ])
    mocks.contactUpdate.mockResolvedValue({ id: 'contact-a' })

    const result = await confirmDriverPersonV1({
      ...confirmationCommand('contact-a'),
      representativeDriverId: 'driver-new',
      searchInput: 'new-search',
      evidenceSnapshot: { profiles: [confirmationEvidence('driver-new')], warnings: [] },
    })

    expect(result).toMatchObject({
      status: 'contradiction',
      contactId: 'contact-a',
      confirmationId: 'confirmation-a',
      conflictingContactIds: ['contact-b', 'contact-c'],
    })
    const update = mocks.contactUpdate.mock.calls[0]?.[0]
    expect(update.data.customFields).toMatchObject({
      confirmedDriverClusterKeys: ['vu:1234567890'],
      driverConfirmations: [expect.objectContaining({
        id: 'confirmation-a',
        representativeDriverId: 'driver-original',
        status: 'confirmed',
        confirmedBy: 'operator-original',
        searchInput: 'original-search',
        reconciliationContactId: null,
      })],
      identityConflicts: [expect.objectContaining({
        conflictType: 'confirmed_driver_cluster_contradiction',
        status: 'open',
        details: expect.objectContaining({
          representativeDriverId: 'driver-new',
          conflictingContactIds: ['contact-b', 'contact-c'],
        }),
      })],
    })
    expect(update.data).not.toHaveProperty('mainDriverId')
    expect(update.data).not.toHaveProperty('mainDriverSelection')
  })
})

describe('Fleet Driver cluster phone ownership', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prismaContactFindMany.mockResolvedValue([])
    mocks.contactUpdate.mockResolvedValue({ id: 'updated-contact' })
    mocks.runOwnership.mockImplementation(async (
      work: (transaction: unknown) => Promise<unknown>,
    ) => work({
      contact: {
        findUnique: mocks.contactFindUnique,
        findMany: mocks.contactFindMany,
        update: mocks.contactUpdate,
      },
      contactPhone: { findMany: mocks.contactPhoneFindMany },
    }))
  })

  test('links through one active trusted, fresh, unique phone owner', async () => {
    mocks.prismaContactPhoneFindMany.mockResolvedValue([
      phoneOwner('phone-a', 'contact-a', ELIGIBLE_PHONE_EVIDENCE),
    ])

    await expect(reconcileDriverClusterContactV1(reconciliationCommand())).resolves.toEqual({
      status: 'link',
      contactId: 'contact-a',
      basis: 'unique_phone',
    })
    expect(mocks.runOwnership).not.toHaveBeenCalled()
  })

  test.each([
    ['unknown', undefined],
    ['shared', { ...ELIGIBLE_PHONE_EVIDENCE, resolutionState: 'shared' }],
    ['disputed', { ...ELIGIBLE_PHONE_EVIDENCE, resolutionState: 'disputed' }],
    ['untrusted', { ...ELIGIBLE_PHONE_EVIDENCE, trust: 'claimed' }],
    ['stale', { ...ELIGIBLE_PHONE_EVIDENCE, freshness: 'stale' }],
    ['lifecycle-ineligible', { ...ELIGIBLE_PHONE_EVIDENCE, lifecycle: 'removed' }],
    ['otherwise eligible', ELIGIBLE_PHONE_EVIDENCE],
  ])('treats active owner B with %s evidence as a conflict instead of letting owner A link', async (
    _label,
    ownerBEvidence,
  ) => {
    mocks.prismaContactPhoneFindMany.mockResolvedValue([
      phoneOwner('phone-a', 'contact-a', ELIGIBLE_PHONE_EVIDENCE),
      phoneOwner('phone-b', 'contact-b', ownerBEvidence),
    ])
    mocks.contactFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      isArchived: false,
      customFields: { preserved: where.id },
    }))

    await expect(reconcileDriverClusterContactV1(reconciliationCommand())).resolves.toEqual({
      status: 'conflict',
      contactIds: ['contact-a', 'contact-b'],
    })

    expect(mocks.runOwnership).toHaveBeenCalledTimes(1)
    expect(mocks.contactUpdate).toHaveBeenCalledTimes(2)
    for (const call of mocks.contactUpdate.mock.calls) {
      expect(call[0]).toEqual(expect.objectContaining({
        data: {
          customFields: expect.objectContaining({
            preserved: call[0].where.id,
            identityConflicts: [expect.objectContaining({
              conflictType: 'fleet_authoritative_person_contradiction',
              source: 'fleet-reconciliation',
              details: {
                profileClusterKey: 'vu:1234567890',
                driverIds: ['driver-a'],
                contactIds: ['contact-a', 'contact-b'],
              },
              status: 'open',
            })],
          }),
        },
      }))
    }
  })

  test('does not let one eligible row hide an ineligible row on the same Contact', async () => {
    mocks.prismaContactPhoneFindMany.mockResolvedValue([
      phoneOwner('phone-a', 'contact-a', ELIGIBLE_PHONE_EVIDENCE),
      phoneOwner('phone-b', 'contact-a'),
    ])

    await expect(reconcileDriverClusterContactV1(reconciliationCommand())).resolves.toEqual({
      status: 'unlinked',
    })
    expect(mocks.runOwnership).not.toHaveBeenCalled()
  })

  test('allows duplicate eligible rows only when they converge on one Contact', async () => {
    mocks.prismaContactPhoneFindMany.mockResolvedValue([
      phoneOwner('phone-a', 'contact-a', ELIGIBLE_PHONE_EVIDENCE),
      phoneOwner('phone-b', 'contact-a', {
        ...ELIGIBLE_PHONE_EVIDENCE,
        trust: 'manually_verified',
      }),
    ])

    await expect(reconcileDriverClusterContactV1(reconciliationCommand())).resolves.toEqual({
      status: 'link',
      contactId: 'contact-a',
      basis: 'unique_phone',
    })
  })
})

describe('confirmed Driver cluster lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('skips an older pending claimant and returns the actual confirmed anchor', async () => {
    mocks.prismaContactFindMany.mockResolvedValue([
      {
        id: 'contact-pending',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-pending',
            profileClusterKey: 'vu:1234567890',
            status: 'needs_reconciliation',
            evidenceRoot: 'operator-confirmation:pending',
          }],
        },
      },
      {
        id: 'contact-confirmed',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-confirmed',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            evidenceRoot: 'operator-confirmation:confirmed',
          }],
        },
      },
    ])

    await expect(getConfirmedContactForDriverClusterV1('vu:1234567890')).resolves.toEqual({
      contactId: 'contact-confirmed',
      confirmationId: 'confirmation-confirmed',
      evidenceRoot: 'operator-confirmation:confirmed',
    })
    expect(mocks.prismaContactFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ isArchived: false }),
    }))
  })

  test('fails closed when more than one confirmed record owns the cluster', async () => {
    mocks.prismaContactFindMany.mockResolvedValue([
      {
        id: 'contact-a',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-a',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            evidenceRoot: 'operator-confirmation:a',
          }],
        },
      },
      {
        id: 'contact-b',
        customFields: {
          confirmedDriverClusterKeys: ['vu:1234567890'],
          driverConfirmations: [{
            id: 'confirmation-b',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            evidenceRoot: 'operator-confirmation:b',
          }],
        },
      },
    ])

    await expect(getConfirmedContactForDriverClusterV1('vu:1234567890')).resolves.toBeNull()
  })

  test('accepts multiple preserved confirmation records when one Contact owns the cluster', async () => {
    mocks.prismaContactFindMany.mockResolvedValue([{
      id: 'contact-survivor',
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [
          {
            id: 'confirmation-newer',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            confirmedAt: '2026-09-02T00:00:00.000Z',
            evidenceRoot: 'operator-confirmation:newer',
          },
          {
            id: 'confirmation-older',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            confirmedAt: '2026-09-01T00:00:00.000Z',
            evidenceRoot: 'operator-confirmation:older',
          },
        ],
      },
    }])

    await expect(getConfirmedContactForDriverClusterV1('vu:1234567890')).resolves.toEqual({
      contactId: 'contact-survivor',
      confirmationId: 'confirmation-older',
      evidenceRoot: 'operator-confirmation:older',
    })
  })

  test('deduplicates pending and confirmed audit records on the same surviving Contact', async () => {
    mocks.prismaContactFindMany.mockResolvedValue([{
      id: 'contact-survivor',
      customFields: {
        confirmedDriverClusterKeys: ['vu:1234567890'],
        driverConfirmations: [
          {
            id: 'confirmation-pending',
            profileClusterKey: 'vu:1234567890',
            status: 'needs_reconciliation',
            evidenceRoot: 'operator-confirmation:pending',
          },
          {
            id: 'confirmation-confirmed',
            profileClusterKey: 'vu:1234567890',
            status: 'confirmed',
            confirmedAt: '2026-09-02T00:00:00.000Z',
            evidenceRoot: 'operator-confirmation:confirmed',
          },
        ],
      },
    }])

    await expect(getConfirmedContactForDriverClusterV1('vu:1234567890')).resolves.toEqual({
      contactId: 'contact-survivor',
      confirmationId: 'confirmation-confirmed',
      evidenceRoot: 'operator-confirmation:confirmed',
    })
  })

  test('proves the exact confirmed main Driver under CNT1', async () => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-1',
      isArchived: false,
      mainDriverId: 'driver-a',
      customFields: {
        driverConfirmations: [{
          status: 'confirmed',
          representativeDriverId: 'driver-a',
        }],
      },
    })

    await expect(isContactConfirmedMainDriverV1('contact-1', 'driver-a'))
      .resolves.toBe(true)
    expect(mocks.lockOwnershipRows).toHaveBeenCalledWith(expect.anything(), {
      contactIds: ['contact-1'],
    })
  })

  test.each([
    ['main Driver mismatch', {
      mainDriverId: 'driver-b',
      driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-a' }],
      identityConflicts: [],
    }],
    ['pending reconciliation', {
      mainDriverId: 'driver-a',
      driverConfirmations: [
        { status: 'confirmed', representativeDriverId: 'driver-a' },
        { status: 'needs_reconciliation', representativeDriverId: 'driver-a' },
      ],
      identityConflicts: [],
    }],
    ['open Driver contradiction', {
      mainDriverId: 'driver-a',
      driverConfirmations: [{ status: 'confirmed', representativeDriverId: 'driver-a' }],
      identityConflicts: [{
        status: 'open',
        conflictType: 'confirmed_driver_cluster_contradiction',
      }],
    }],
  ])('fails closed for %s', async (_label, state) => {
    mocks.contactFindUnique.mockResolvedValue({
      id: 'contact-1',
      isArchived: false,
      mainDriverId: state.mainDriverId,
      customFields: {
        driverConfirmations: state.driverConfirmations,
        identityConflicts: state.identityConflicts,
      },
    })

    await expect(isContactConfirmedMainDriverV1('contact-1', 'driver-a'))
      .resolves.toBe(false)
  })
})

function confirmationCommand(contactId: string) {
  return {
    contract: 'contacts.ConfirmDriverPersonCommand.v1' as const,
    contactId,
    profileClusterKey: 'vu:1234567890',
    representativeDriverId: 'driver-a',
    confirmedBy: 'operator-1',
    confirmationBasis: 'vu' as const,
    searchInput: '1234567890',
    evidenceSnapshot: { profiles: [confirmationEvidence('driver-a')], warnings: [] },
  }
}

function confirmationEvidence(
  driverId: string,
  sourceFreshness: 'fresh' | 'stale' | 'unknown' = 'fresh',
) {
  return {
    driverId,
    externalParkId: 'park-1',
    externalDriverProfileId: `profile-${driverId}`,
    fullName: 'Иванов Иван',
    phones: ['+79990000001'],
    normalizedVu: '1234567890',
    evidenceRoot: `yandex:park-1:profile-${driverId}:observation-1`,
    sourceFreshness,
  }
}

const ELIGIBLE_PHONE_EVIDENCE = {
  lifecycle: 'current',
  trust: 'provider_bound',
  freshness: 'fresh',
  resolutionState: 'unique',
} as const

function phoneOwner(
  id: string,
  contactId: string,
  evidence?: Record<string, unknown>,
) {
  return {
    id,
    contactId,
    phone: '+79990000001',
    isActive: true,
    verifiedAt: null,
    contact: {
      customFields: evidence
        ? { phoneEvidenceByPhoneId: { [id]: evidence } }
        : {},
    },
  }
}

function reconciliationCommand() {
  return {
    contract: 'contacts.ReconcileDriverClusterCommand.v1' as const,
    profileClusterKey: 'vu:1234567890',
    profiles: [confirmationEvidence('driver-a')],
  }
}
