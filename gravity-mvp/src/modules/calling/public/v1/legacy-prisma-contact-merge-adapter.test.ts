import { describe, expect, test, vi } from 'vitest'

import type { AutomatedMergeRecoveryPlanV1 } from '@/modules/contacts/public/v1/automated-contact-merge-recovery'
import { makeCallingAutomatedMergeRecoveryRepositoryV1 } from './legacy-prisma-contact-merge-adapter'

const plan: AutomatedMergeRecoveryPlanV1 = {
  mergeId: 'merge-1',
  mergedId: 'source-contact',
  survivorId: 'survivor-contact',
  identityIds: [],
  phoneIds: [],
  chatIds: [],
  taskIds: [],
  callIds: ['source-call'],
  driverProfileIds: [],
}

describe('Calling automated Contact merge recovery', () => {
  test('blocks a post-merge Call that still references the archived Contact', async () => {
    const planWithoutOriginalCalls = { ...plan, callIds: [] }
    const count = vi.fn(async () => 1)
    const repository = makeCallingAutomatedMergeRecoveryRepositoryV1({ call: { count } } as never)

    await expect(repository.canRestore(planWithoutOriginalCalls)).resolves.toBe(false)
    expect(count).toHaveBeenCalledOnce()
    expect(count).toHaveBeenCalledWith({ where: { contactId: plan.mergedId } })
  })

  test('allows unrelated new survivor Calls while the planned Call remains intact', async () => {
    const count = vi.fn()
      .mockResolvedValueOnce(0)
      .mockResolvedValueOnce(1)
    const repository = makeCallingAutomatedMergeRecoveryRepositoryV1({ call: { count } } as never)

    await expect(repository.canRestore(plan)).resolves.toBe(true)
    expect(count).toHaveBeenNthCalledWith(1, { where: { contactId: plan.mergedId } })
    expect(count).toHaveBeenNthCalledWith(2, {
      where: { id: { in: plan.callIds }, contactId: plan.survivorId },
    })
  })
})
