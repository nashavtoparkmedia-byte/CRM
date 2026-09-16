import { describe, expect, test, vi } from 'vitest'

import type { ReconcileYandexFleetResultV1 } from '@/modules/fleet-operations/public/v1'
import { reconcileYandexFleetWithAutomaticMergeV1 } from './yandex-fleet-reconciliation'

function result(candidatePairs: string[][] = [], suffix = 'initial'): ReconcileYandexFleetResultV1 {
  return {
    mode: 'manual',
    checkedParks: 1,
    succeededParks: 1,
    failedParks: 0,
    profilesObserved: 1,
    profilesUpserted: 1,
    clusters: candidatePairs.map((contactMergeCandidateIds, index) => ({
      profileClusterKey: `${suffix}-${index}`,
      normalizedVu: null,
      contactId: null,
      contactMergeCandidateIds,
      profileIds: [],
      profiles: [],
      warnings: ['contact_auto_merge_candidate'],
    })),
    errors: [],
    partial: false,
  }
}

describe('Platform Fleet/Contacts reconciliation coordination', () => {
  test('does not invoke Contacts automation without an exact pair', async () => {
    const initial = result([['contact-a', 'contact-b', 'contact-c']])
    const reconcile = vi.fn().mockResolvedValue(initial)
    const attemptAutomaticMerge = vi.fn()

    await expect(reconcileYandexFleetWithAutomaticMergeV1({}, {
      reconcile,
      attemptAutomaticMerge,
    })).resolves.toBe(initial)

    expect(attemptAutomaticMerge).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test('does not invoke Contacts automation for a candidate pair from partial park coverage', async () => {
    const initial: ReconcileYandexFleetResultV1 = {
      ...result([['contact-a', 'contact-b']]),
      failedParks: 1,
      partial: true,
      errors: [{
        parkId: 'park-failed',
        parkName: 'Unavailable park',
        message: 'temporarily unavailable',
      }],
    }
    const reconcile = vi.fn().mockResolvedValue(initial)
    const attemptAutomaticMerge = vi.fn()

    await expect(reconcileYandexFleetWithAutomaticMergeV1({}, {
      reconcile,
      attemptAutomaticMerge,
    })).resolves.toBe(initial)

    expect(attemptAutomaticMerge).not.toHaveBeenCalled()
    expect(reconcile).toHaveBeenCalledTimes(1)
  })

  test('deduplicates exact pairs and runs one follow-up after a successful merge', async () => {
    const initial = result([
      ['contact-b', 'contact-a'],
      ['contact-a', 'contact-b'],
      ['contact-c', 'contact-d'],
    ])
    const reconciled = result([], 'reconciled')
    const reconcile = vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(reconciled)
    const attemptAutomaticMerge = vi.fn()
      .mockResolvedValueOnce({ status: 'merged' })
      .mockResolvedValueOnce({ status: 'policy_blocked' })

    await expect(reconcileYandexFleetWithAutomaticMergeV1({}, {
      reconcile,
      attemptAutomaticMerge,
    })).resolves.toBe(reconciled)

    expect(attemptAutomaticMerge.mock.calls).toEqual([
      [{ leftContactId: 'contact-a', rightContactId: 'contact-b' }],
      [{ leftContactId: 'contact-c', rightContactId: 'contact-d' }],
    ])
    expect(reconcile).toHaveBeenCalledTimes(2)
  })

  test('preserves the first Fleet result when Contacts automation fails or blocks', async () => {
    const initial = result([
      ['contact-a', 'contact-b'],
      ['contact-c', 'contact-d'],
    ])
    const reconcile = vi.fn().mockResolvedValue(initial)
    const attemptAutomaticMerge = vi.fn()
      .mockRejectedValueOnce(new Error('temporarily unavailable'))
      .mockResolvedValueOnce({ status: 'policy_blocked' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(reconcileYandexFleetWithAutomaticMergeV1({}, {
      reconcile,
      attemptAutomaticMerge,
    })).resolves.toBe(initial)

    expect(reconcile).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledOnce()
    log.mockRestore()
  })
})
