import { describe, expect, test, vi } from 'vitest'

import { RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1 } from '@/contracts/contacts/v1'
import {
  createRecoverAutomatedContactMergeHandlerV1,
  type AutomatedMergeRecoveryPlanV1,
  type AutomatedMergeRecoveryRepositoriesV1,
} from './automated-contact-merge-recovery'

const plan: AutomatedMergeRecoveryPlanV1 = {
  mergeId: 'merge-1',
  mergedId: 'loser',
  survivorId: 'survivor',
  identityIds: ['identity-1'],
  phoneIds: ['phone-1'],
  chatIds: ['chat-1'],
  taskIds: ['task-1'],
  callIds: ['call-1'],
  driverProfileIds: ['driver-1'],
}

function harness(blockedOwner?: keyof Pick<
  AutomatedMergeRecoveryRepositoriesV1,
  'messaging' | 'work'
>) {
  const calls: string[] = []
  const owner = (name: string) => ({
    canRestore: vi.fn(async () => {
      calls.push(`${name}.canRestore`)
      return name !== blockedOwner
    }),
    restore: vi.fn(async () => { calls.push(`${name}.restore`) }),
  })
  const repositories: AutomatedMergeRecoveryRepositoriesV1 = {
    contacts: {
      admitOwnershipMutation: vi.fn(async () => { calls.push('contacts.admit') }),
      discoverPair: vi.fn(async () => {
        calls.push('contacts.discover')
        return { mergedId: plan.mergedId, survivorId: plan.survivorId }
      }),
      lockPair: vi.fn(async () => { calls.push('contacts.lock') }),
      inspect: vi.fn(async () => {
        calls.push('contacts.inspect')
        return { status: 'eligible' as const, plan }
      }),
      restore: vi.fn(async () => { calls.push('contacts.restore') }),
      markManualReconciliation: vi.fn(async () => { calls.push('contacts.manual') }),
      markRecovered: vi.fn(async () => { calls.push('contacts.recovered') }),
      verifyPostconditions: vi.fn(async () => { calls.push('contacts.verify') }),
    },
    messaging: owner('messaging'),
    work: owner('work'),
  }
  const handler = createRecoverAutomatedContactMergeHandlerV1({
    run: operation => operation(repositories),
  })
  const command = {
    contract: RECOVER_AUTOMATED_CONTACT_MERGE_COMMAND_V1,
    mergeId: plan.mergeId,
    requestedBy: 'operator-1',
    basis: 'incorrect automated merge',
  }
  return { calls, command, handler, repositories }
}

describe('bounded automated Contact merge recovery', () => {
  test('restores through every current owner only after admission, locking and strict checks', async () => {
    const testHarness = harness()
    await expect(testHarness.handler(testHarness.command)).resolves.toMatchObject({
      status: 'recovered', mergeId: 'merge-1',
    })
    expect(testHarness.calls).toEqual([
      'contacts.admit', 'contacts.discover', 'contacts.lock', 'contacts.inspect',
      'messaging.canRestore', 'work.canRestore',
      'messaging.restore', 'work.restore',
      'contacts.restore', 'contacts.recovered', 'contacts.verify',
    ])
  })

  test('persists manual reconciliation without partial reversal when any owner changed', async () => {
    const testHarness = harness('work')
    await expect(testHarness.handler(testHarness.command)).resolves.toMatchObject({
      status: 'manual_reconciliation', reason: 'work_state_changed',
    })
    expect(testHarness.calls).toEqual([
      'contacts.admit', 'contacts.discover', 'contacts.lock', 'contacts.inspect',
      'messaging.canRestore', 'work.canRestore', 'contacts.manual',
    ])
    expect(testHarness.repositories.messaging.restore).not.toHaveBeenCalled()
    expect(testHarness.repositories.contacts.restore).not.toHaveBeenCalled()
  })
})
