import type { ReconcileYandexFleetCommandV1 } from '@/contracts/fleet-operations/v1'
import { executeAutomaticContactMergeV1 } from '@/infrastructure/automatic-contact-merge'
import {
  reconcileYandexFleetV1,
  type ReconcileYandexFleetResultV1,
} from '@/modules/fleet-operations/public/v1'

type ReconcileFleetV1 = (
  command: ReconcileYandexFleetCommandV1 | unknown,
) => Promise<ReconcileYandexFleetResultV1>

type AttemptAutomaticMergeV1 = (input: {
  leftContactId: string
  rightContactId: string
}) => Promise<{ status: string }>

export type YandexFleetContactMergeDependenciesV1 = {
  reconcile?: ReconcileFleetV1
  attemptAutomaticMerge?: AttemptAutomaticMergeV1
}

function exactCandidatePairs(result: ReconcileYandexFleetResultV1): Array<[string, string]> {
  const pairs = new Map<string, [string, string]>()
  for (const cluster of result.clusters) {
    const ids = [...new Set(cluster.contactMergeCandidateIds ?? [])]
      .map(contactId => contactId.trim())
      .filter(Boolean)
      .sort()
    if (ids.length !== 2) continue
    pairs.set(`${ids[0]}\0${ids[1]}`, [ids[0], ids[1]])
  }
  return [...pairs.values()]
}

/**
 * Platform-owned coordination around the single Fleet reconciler.
 * Fleet only reports an exact Contact pair after releasing its ownership
 * transaction; Contacts then re-derives policy under CNT1 + pair locks.
 * At most one follow-up reconciliation is run, regardless of pair count.
 */
export async function reconcileYandexFleetWithAutomaticMergeV1(
  command: ReconcileYandexFleetCommandV1 | unknown,
  dependencies: YandexFleetContactMergeDependenciesV1 = {},
): Promise<ReconcileYandexFleetResultV1> {
  const reconcile = dependencies.reconcile ?? reconcileYandexFleetV1
  const attemptAutomaticMerge = dependencies.attemptAutomaticMerge ?? executeAutomaticContactMergeV1
  const initial = await reconcile(command)
  // Candidate ownership is authoritative only after complete park coverage.
  // A pair observed while any park failed can omit a third current owner, so
  // preserve the partial Fleet evidence without attempting a Contact merge.
  if (initial.partial || initial.failedParks > 0) return initial
  let merged = false
  for (const [leftContactId, rightContactId] of exactCandidatePairs(initial)) {
    try {
      const outcome = await attemptAutomaticMerge({ leftContactId, rightContactId })
      if (outcome.status === 'merged') merged = true
    } catch (error) {
      // Fleet reconciliation remains useful and fail-closed when optional
      // Contacts automation is temporarily unavailable.
      console.error('[platform-shell] Fleet Contact merge attempt failed:', error)
    }
  }
  return merged ? reconcile(command) : initial
}
