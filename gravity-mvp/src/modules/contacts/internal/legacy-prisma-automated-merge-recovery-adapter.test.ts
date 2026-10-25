import { describe, expect, test, vi } from 'vitest'

import type { AutomatedMergeRecoveryInspectionV1 } from '../public/v1/automated-contact-merge-recovery'
import { makePrismaAutomatedMergeRecoveryContactsRepositoryV1 } from './legacy-prisma-automated-merge-recovery-adapter'

/** The plan of an eligible inspection; anything else is a test failure, not a cast. */
function planOf(inspection: AutomatedMergeRecoveryInspectionV1) {
  if (inspection.status !== 'eligible') throw new Error(`inspection is not eligible: ${JSON.stringify(inspection)}`)
  return inspection.plan
}

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

describe('automated merge recovery reverses the communication policy composition', () => {
  type Row = { denyAll: boolean; denyMessage: boolean; denyVoice: boolean; version: number }
  const ALL = { denyAll: true, denyMessage: false, denyVoice: false }
  const NONE = { denyAll: false, denyMessage: false, denyVoice: false }

  /** A B -> C merge whose every pre-existing recovery check passes, so the policy decision is reached. */
  function eligibleMergeRow(communicationPolicy: unknown) {
    const row = mergeRow()
    const metadata: Record<string, unknown> = { automated: true, recoveryState: 'recoverable' }
    if (communicationPolicy !== undefined) metadata.communicationPolicy = communicationPolicy
    row.snapshotBefore = { ...snapshot(), _merge: metadata } as typeof row.snapshotBefore
    row.survivor = {
      ...row.survivor,
      displayName: 'c',
      displayNameSource: 'channel',
      masterSource: 'chat',
      yandexDriverId: null,
      mainDriverId: null,
      mainDriverSelection: 'auto',
      mainDriverSelectedBy: null,
      mainDriverSelectedAt: null,
      notes: null,
      tags: [],
      primaryPhoneId: null,
      customFields: { doNotMerge: false, phoneEvidenceByPhoneId: {} },
    } as typeof row.survivor
    return row
  }

  function policyHarness(options: {
    evidence?: unknown
    survivor: Row | null
    source: Row | null
    laterEvents?: Array<{ cause: string; version: number; mergeId: string | null }>
    updateCount?: number
  }) {
    const merge = eligibleMergeRow(options.evidence)
    const policyWrites: Array<Record<string, unknown>> = []
    const events: Array<Record<string, unknown>> = []
    const transaction = {
      contactMerge: {
        findUnique: vi.fn(async () => merge),
        findMany: vi.fn(async () => []),
        update: vi.fn(async () => undefined),
      },
      contact: { update: vi.fn(async () => undefined), findUnique: vi.fn(async () => null) },
      contactIdentity: { updateMany: vi.fn(async () => ({ count: 0 })) },
      contactPhone: { updateMany: vi.fn(async () => ({ count: 0 })), update: vi.fn(async () => undefined) },
      contactCommunicationPolicy: {
        findUnique: vi.fn(async ({ where }: { where: { contactId: string } }) => (
          where.contactId === 'c' ? options.survivor : where.contactId === 'b' ? options.source : null
        )),
        updateMany: vi.fn(async (input: Record<string, unknown>) => { policyWrites.push(input); return { count: options.updateCount ?? 1 } }),
        create: vi.fn(async (input: Record<string, unknown>) => { policyWrites.push(input); return {} }),
      },
      contactCommunicationPolicyEvent: {
        findMany: vi.fn(async () => options.laterEvents ?? []),
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => { events.push(data); return data }),
      },
    }
    return { repository: makePrismaAutomatedMergeRecoveryContactsRepositoryV1(transaction as never), transaction, policyWrites, events }
  }

  test('restores the survivor pre-merge flags at a new version with a merge_recovery event, leaving the merged-away row alone', async () => {
    const evidence = { sourceBefore: { ...ALL, version: 1 }, survivorBefore: null, composed: { ...ALL, version: 1 } }
    const harness = policyHarness({ evidence, survivor: { ...ALL, version: 1 }, source: { ...ALL, version: 1 } })
    const inspection = await harness.repository.inspect('merge-b-c')
    expect(inspection).toMatchObject({ status: 'eligible', plan: { mergeId: 'merge-b-c', mergedId: 'b', survivorId: 'c' } })
    await harness.repository.restore(planOf(inspection))
    expect(harness.policyWrites).toEqual([{
      where: { contactId: 'c', version: 1 },
      data: { ...NONE, version: 2, updatedBy: 'contacts:automated-merge-recovery' },
    }])
    expect(harness.events).toEqual([expect.objectContaining({
      contactId: 'c', cause: 'merge_recovery', version: 2, previousVersion: 1,
      beforeDenyAll: true, afterDenyAll: false, afterDenyMessage: false, afterDenyVoice: false,
      mergeId: 'merge-b-c', sourceContactId: 'b', actor: 'contacts:automated-merge-recovery', reason: 'merge_recovery:merge-b-c',
    })])
    expect(harness.transaction.contactCommunicationPolicy.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ contactId: 'b' }) }),
    )
  })

  test('restores the survivor pre-merge flags, not an empty state, when the survivor had a policy of its own', async () => {
    const survivorBefore = { denyAll: false, denyMessage: false, denyVoice: true, version: 3 }
    const composed = { denyAll: true, denyMessage: false, denyVoice: true, version: 4 }
    const evidence = { sourceBefore: { ...ALL, version: 1 }, survivorBefore, composed }
    const harness = policyHarness({ evidence, survivor: composed, source: { ...ALL, version: 1 } })
    const inspection = await harness.repository.inspect('merge-b-c')
    expect(inspection.status).toBe('eligible')
    await harness.repository.restore(planOf(inspection))
    expect(harness.policyWrites[0]).toMatchObject({ where: { contactId: 'c', version: 4 }, data: { denyAll: false, denyMessage: false, denyVoice: true, version: 5 } })
  })

  test('routes to manual reconciliation when the survivor policy was decided again after the merge', async () => {
    const evidence = { sourceBefore: { ...ALL, version: 1 }, survivorBefore: null, composed: { ...ALL, version: 1 } }
    const harness = policyHarness({
      evidence,
      survivor: { ...NONE, version: 2 },
      source: { ...ALL, version: 1 },
      laterEvents: [{ cause: 'mutation', version: 2, mergeId: null }],
    })
    await expect(harness.repository.inspect('merge-b-c')).resolves.toEqual({
      status: 'blocked', reason: 'communication_policy_changed_after_merge', eligibleAttempt: true,
    })
    expect(harness.policyWrites).toEqual([])
  })

  test('routes a merge recorded before the foundation to manual reconciliation when the survivor now carries a policy', async () => {
    const harness = policyHarness({ evidence: undefined, survivor: { ...ALL, version: 1 }, source: null })
    await expect(harness.repository.inspect('merge-b-c')).resolves.toEqual({
      status: 'blocked', reason: 'communication_policy_without_merge_evidence', eligibleAttempt: true,
    })
  })

  test('a merge recorded before the foundation with no survivor policy restores nothing and stays eligible', async () => {
    const harness = policyHarness({ evidence: undefined, survivor: null, source: null })
    const inspection = await harness.repository.inspect('merge-b-c')
    expect(inspection.status).toBe('eligible')
    await harness.repository.restore(planOf(inspection))
    expect(harness.policyWrites).toEqual([])
    expect(harness.events).toEqual([])
  })

  test('tolerates a later merge into the survivor that was already reversed (X -> C after B -> C recovered)', async () => {
    const evidence = { sourceBefore: { ...ALL, version: 1 }, survivorBefore: null, composed: { ...ALL, version: 1 } }
    const harness = policyHarness({
      evidence,
      survivor: { ...ALL, version: 3 },
      source: { ...ALL, version: 1 },
      laterEvents: [{ cause: 'merge', version: 2, mergeId: 'merge-d-c' }, { cause: 'merge_recovery', version: 3, mergeId: 'merge-d-c' }],
    })
    const inspection = await harness.repository.inspect('merge-b-c')
    expect(inspection.status).toBe('eligible')
    await harness.repository.restore(planOf(inspection))
    expect(harness.policyWrites[0]).toMatchObject({ where: { contactId: 'c', version: 3 }, data: { version: 4 } })
  })

  test('restore fails closed instead of overwriting when the survivor row moved after inspection', async () => {
    const evidence = { sourceBefore: { ...ALL, version: 1 }, survivorBefore: null, composed: { ...ALL, version: 1 } }
    const harness = policyHarness({ evidence, survivor: { ...ALL, version: 1 }, source: { ...ALL, version: 1 }, updateCount: 0 })
    const inspection = await harness.repository.inspect('merge-b-c')
    await expect(harness.repository.restore(planOf(inspection))).rejects.toThrow(/no longer current/u)
    expect(harness.events).toEqual([])
  })
})
