import { describe, expect, test, vi } from 'vitest'

import { makePrismaAutomatedMergeRecoveryContactsRepositoryV1 } from './legacy-prisma-automated-merge-recovery-adapter'

type SnapshotPhone = { id: string; isActive: boolean; isPrimary: boolean }
type SnapshotIdentity = { id: string; phoneId: string | null }

function contactSnapshot(
  id: string,
  phones: SnapshotPhone[] = [],
  identities: SnapshotIdentity[] = [],
) {
  return {
    contact: {
      id,
      displayName: id,
      displayNameSource: 'channel',
      masterSource: 'chat',
      yandexDriverId: null,
      mainDriverId: null,
      mainDriverSelection: 'auto',
      mainDriverSelectedBy: null,
      mainDriverSelectedAt: null,
      primaryPhoneId: phones.find(phone => phone.isPrimary)?.id ?? null,
      notes: null,
      tags: [],
      doNotMerge: false,
      customFields: {},
    },
    phones,
    identities,
    chatIds: [],
    taskIds: [],
    callIds: [],
    driverProfileIds: [],
  }
}

function snapshot(
  sourcePhones: SnapshotPhone[] = [],
  survivorPhones: SnapshotPhone[] = [],
  sourceIdentities: SnapshotIdentity[] = [],
  survivorIdentities: SnapshotIdentity[] = [],
) {
  return {
    ...contactSnapshot('b', sourcePhones, sourceIdentities),
    survivorBefore: contactSnapshot('c', survivorPhones, survivorIdentities),
    _merge: { automated: true, recoveryState: 'recoverable' },
  }
}

function mergeRow(
  sourcePhones: SnapshotPhone[] = [],
  survivorPhones: SnapshotPhone[] = [],
  sourceIdentities: SnapshotIdentity[] = [],
  survivorIdentities: SnapshotIdentity[] = [],
) {
  return {
    id: 'merge-b-c',
    mergedId: 'b',
    survivorId: 'c',
    snapshotBefore: snapshot(sourcePhones, survivorPhones, sourceIdentities, survivorIdentities),
    merged: {
      id: 'b',
      isArchived: true,
      customFields: { mergedIntoContactId: 'c' },
      identities: [] as SnapshotIdentity[],
      phones: [],
    },
    survivor: {
      id: 'c',
      isArchived: false,
      customFields: {},
      identities: [] as SnapshotIdentity[],
      phones: [] as SnapshotPhone[],
    },
  }
}

describe('automated merge recovery inspection', () => {
  test('blocks B -> C recovery when an A -> B descendant was flattened to C', async () => {
    const merge = mergeRow()
    const transaction = {
      contactMerge: {
        findUnique: vi.fn(async () => merge),
        findMany: vi.fn(async () => [{
          merged: {
            id: 'a',
            isArchived: true,
            customFields: { mergedIntoContactId: 'c' },
          },
        }]),
      },
    }
    const repository = makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction as never)

    await expect(repository.inspect('merge-b-c')).resolves.toEqual({
      status: 'blocked',
      reason: 'dependent_merge_lineage_redirect_changed',
      eligibleAttempt: true,
    })
  })

  test('blocks recovery when a merged phone lifecycle changed after the snapshot', async () => {
    const sourcePhone = { id: 'phone-b', isActive: true, isPrimary: false }
    const survivorPhone = { id: 'phone-c', isActive: true, isPrimary: true }
    const merge = mergeRow([sourcePhone], [survivorPhone])
    merge.survivor.phones = [
      { ...sourcePhone, isActive: false },
      survivorPhone,
    ]
    const transaction = {
      contactMerge: {
        findUnique: vi.fn(async () => merge),
        findMany: vi.fn(async () => []),
      },
    }
    const repository = makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction as never)

    await expect(repository.inspect('merge-b-c')).resolves.toEqual({
      status: 'blocked',
      reason: 'phone_lifecycle_state_changed',
      eligibleAttempt: true,
    })
  })

  test('blocks recovery when a current identity was relinked to the survivor phone', async () => {
    const sourcePhone = { id: 'phone-b', isActive: true, isPrimary: false }
    const survivorPhone = { id: 'phone-c', isActive: true, isPrimary: true }
    const sourceIdentity = { id: 'identity-b', phoneId: 'phone-b' }
    const survivorIdentity = { id: 'identity-c', phoneId: 'phone-c' }
    const merge = mergeRow(
      [sourcePhone],
      [survivorPhone],
      [sourceIdentity],
      [survivorIdentity],
    )
    merge.survivor.phones = [sourcePhone, survivorPhone]
    merge.survivor.identities = [
      { ...sourceIdentity, phoneId: 'phone-c' },
      survivorIdentity,
    ]
    const transaction = {
      contactMerge: {
        findUnique: vi.fn(async () => merge),
        findMany: vi.fn(async () => []),
      },
    }
    const repository = makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction as never)

    await expect(repository.inspect('merge-b-c')).resolves.toEqual({
      status: 'blocked',
      reason: 'identity_phone_link_changed',
      eligibleAttempt: true,
    })
  })

  test('marking B -> C recovered does not erase C predecessor recovery state from X -> C', async () => {
    const predecessorFields = { mergeRecoveryState: 'recoverable', predecessorMergeId: 'merge-x-c' }
    const contactFindUnique = vi.fn(async () => ({ customFields: predecessorFields }))
    const contactUpdate = vi.fn()
    const transaction = {
      contactMerge: {
        findUnique: vi.fn(async () => ({
          snapshotBefore: {
            ...snapshot(),
            _merge: { automated: true, recoveryState: 'recoverable' },
          },
        })),
        update: vi.fn(async () => undefined),
      },
      contact: {
        findUnique: contactFindUnique,
        update: contactUpdate,
      },
    }
    const repository = makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction as never)

    await repository.markRecovered({
      mergeId: 'merge-b-c',
      mergedId: 'b',
      survivorId: 'c',
      requestedBy: 'operator-1',
      basis: 'reverse latest merge only',
    })

    expect(contactFindUnique).not.toHaveBeenCalled()
    expect(contactUpdate).not.toHaveBeenCalled()
    expect(predecessorFields).toEqual({
      mergeRecoveryState: 'recoverable',
      predecessorMergeId: 'merge-x-c',
    })
  })
})
