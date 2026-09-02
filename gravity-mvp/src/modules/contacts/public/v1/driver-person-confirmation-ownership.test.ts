import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  runOwnership: vi.fn(),
  lockHeld: false,
  releaseWaiters: [] as Array<() => void>,
}))

vi.mock('@/lib/prisma', () => ({ prisma: {} }))
vi.mock('../../internal/contact-ownership-coordinator', () => ({
  lockContactOwnershipRows: vi.fn(),
  runContactOwnershipTransaction: mocks.runOwnership,
}))

import {
  DRIVER_CLUSTER_CONTACT_OWNERSHIP_TIMEOUT_MS_V1,
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
        return await work({ contact: {}, contactPhone: {} })
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
})
