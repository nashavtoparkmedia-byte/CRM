import { contactAutomationState, jsonRecord } from '../public/v1/contact-evidence-state'
import type { MergeIdentityRemapV1 } from '../public/v1/contact-merge-handler'

function mergeJsonArrays(sourceValue: unknown, targetValue: unknown, limit: number): unknown[] {
  const merged = new Map<string, unknown>()
  for (const [index, item] of [
    ...(Array.isArray(sourceValue) ? sourceValue : []),
    ...(Array.isArray(targetValue) ? targetValue : []),
  ].entries()) {
    const record = jsonRecord(item)
    const key = typeof record.id === 'string'
      ? `id:${record.id}`
      : `value:${JSON.stringify(item)}:${index}`
    merged.set(key, item)
  }
  return [...merged.values()].slice(-limit)
}

/**
 * Re-points conflict journal entries at the identity row that survived dedup.
 *
 * Person-blocking is an inner join between an immutable journal entry and a
 * mutable ContactIdentity row on `identityId`. Merge dedup deletes one side of
 * that join, and an empty join is read as "no conflict" — so without this the
 * merge silently turns a blocking conflict into a non-blocking one. The deleted
 * and surviving rows are the same identity by the merge's own dedup key, so the
 * substitution is exact rather than inferred.
 *
 * Only `identityId` is rewritten. Nothing reclassifies the conflict: `id`,
 * `conflictType`, `source`, `status`, `details`, `reason`, `detectedAt`,
 * `otherContactIds` and any resolution payload are carried through untouched.
 * Entries with no mapping, no `identityId`, or an id this merge did not
 * deduplicate are returned unchanged, and an array in which nothing matched is
 * returned by identity so a merge without dedup composes exactly as before.
 */
function withRemappedIdentityConflicts(
  value: unknown,
  survivingIdentityByDeletedId: ReadonlyMap<string, string>,
): unknown {
  if (!Array.isArray(value) || survivingIdentityByDeletedId.size === 0) return value
  let remapped = false
  const next = value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const conflict = item as Record<string, unknown>
    const identityId = conflict.identityId
    if (typeof identityId !== 'string') return item
    const survivingIdentityId = survivingIdentityByDeletedId.get(identityId)
    if (survivingIdentityId === undefined || survivingIdentityId === identityId) return item
    remapped = true
    return { ...conflict, identityId: survivingIdentityId }
  })
  return remapped ? next : value
}

function confirmedClusterKeys(value: unknown): Set<string> {
  return new Set((Array.isArray(value) ? value : [])
    .map(item => jsonRecord(item))
    .filter(item => item.status === 'confirmed' && typeof item.profileClusterKey === 'string')
    .map(item => String(item.profileClusterKey)))
}

function completePairReconciliations(
  value: unknown,
  otherContactId: string,
  otherConfirmedClusterKeys: Set<string>,
): unknown {
  if (!Array.isArray(value)) return value
  return value.map(item => {
    const confirmation = jsonRecord(item)
    return confirmation.status === 'needs_reconciliation'
      && confirmation.reconciliationContactId === otherContactId
      && typeof confirmation.profileClusterKey === 'string'
      && otherConfirmedClusterKeys.has(confirmation.profileClusterKey)
      ? { ...confirmation, status: 'confirmed' }
      : item
  })
}

function validParkSnapshot(value: unknown, completeOnly: boolean): { value: unknown; checkedAt: number } | null {
  const snapshot = jsonRecord(value)
  if (typeof snapshot.checkStatus !== 'string' || snapshot.checkStatus.trim() === '') return null
  if (completeOnly && snapshot.checkStatus !== 'complete') return null
  if (typeof snapshot.checkedAt !== 'string') return null
  const checkedAt = Date.parse(snapshot.checkedAt)
  return Number.isFinite(checkedAt) ? { value, checkedAt } : null
}

function latestParkSnapshot(
  sourceValue: unknown,
  targetValue: unknown,
  completeOnly: boolean,
): unknown | null {
  const source = validParkSnapshot(sourceValue, completeOnly)
  const target = validParkSnapshot(targetValue, completeOnly)
  if (!source) return target?.value ?? null
  if (!target) return source.value
  return source.checkedAt > target.checkedAt ? source.value : target.value
}

export function composeContactCustomFieldsV1(input: {
  sourceContactId: string
  targetContactId: string
  sourceFields: unknown
  targetFields: unknown
  /**
   * The deleted -> surviving identity table this merge applied. Omitted by
   * callers that compose no merge of their own — notably the automated recovery
   * re-derivation, whose expected value must stay exactly what it was.
   */
  identityRemaps?: ReadonlyArray<MergeIdentityRemapV1>
}): Record<string, unknown> {
  const sourceFields = jsonRecord(input.sourceFields)
  const targetFields = jsonRecord(input.targetFields)
  const sourcePhoneEvidence = jsonRecord(sourceFields.phoneEvidenceByPhoneId)
  const targetPhoneEvidence = jsonRecord(targetFields.phoneEvidenceByPhoneId)
  const sourceConfirmedClusterKeys = confirmedClusterKeys(sourceFields.driverConfirmations)
  const targetConfirmedClusterKeys = confirmedClusterKeys(targetFields.driverConfirmations)
  const sourceConfirmations = completePairReconciliations(
    sourceFields.driverConfirmations,
    input.targetContactId,
    targetConfirmedClusterKeys,
  )
  const targetConfirmations = completePairReconciliations(
    targetFields.driverConfirmations,
    input.sourceContactId,
    sourceConfirmedClusterKeys,
  )
  const hasConfirmations = Array.isArray(sourceConfirmations) || Array.isArray(targetConfirmations)
  const survivingIdentityByDeletedId = new Map(
    (input.identityRemaps ?? []).map(remap => [remap.oldId, remap.newId] as const),
  )
  const sourceConflicts = withRemappedIdentityConflicts(sourceFields.identityConflicts, survivingIdentityByDeletedId)
  const targetConflicts = withRemappedIdentityConflicts(targetFields.identityConflicts, survivingIdentityByDeletedId)
  const hasConflicts = Array.isArray(sourceFields.identityConflicts) || Array.isArray(targetFields.identityConflicts)
  const hasAutomaticMergeBlocks = Array.isArray(sourceFields.automaticMergeBlocks)
    || Array.isArray(targetFields.automaticMergeBlocks)
  const driverConfirmations = hasConfirmations
    ? mergeJsonArrays(sourceConfirmations, targetConfirmations, 100)
    : null
  const confirmedDriverClusterKeys = driverConfirmations
    ? [...new Set(driverConfirmations
      .map(item => jsonRecord(item))
      .filter(item => item.status === 'confirmed' || item.status === 'needs_reconciliation')
      .map(item => item.profileClusterKey)
      .filter((key): key is string => typeof key === 'string' && Boolean(key)))]
      .sort()
    : null

  const composed: Record<string, unknown> = {
    ...sourceFields,
    ...targetFields,
    doNotMerge: contactAutomationState(targetFields).doNotMerge
      || contactAutomationState(sourceFields).doNotMerge,
    phoneEvidenceByPhoneId: { ...sourcePhoneEvidence, ...targetPhoneEvidence },
    ...(driverConfirmations ? {
      driverConfirmations,
      confirmedDriverClusterKeys,
    } : {}),
    ...(hasConflicts ? {
      identityConflicts: mergeJsonArrays(
        sourceConflicts,
        targetConflicts,
        200,
      ),
    } : {}),
    ...(hasAutomaticMergeBlocks ? {
      automaticMergeBlocks: mergeJsonArrays(
        sourceFields.automaticMergeBlocks,
        targetFields.automaticMergeBlocks,
        100,
      ),
    } : {}),
  }
  const parkCheckResult = latestParkSnapshot(
    sourceFields.parkCheckResult,
    targetFields.parkCheckResult,
    true,
  )
  const parkCheckLastAttempt = latestParkSnapshot(
    sourceFields.parkCheckLastAttempt,
    targetFields.parkCheckLastAttempt,
    false,
  )
  if (parkCheckResult === null) delete composed.parkCheckResult
  else composed.parkCheckResult = parkCheckResult
  if (parkCheckLastAttempt === null) delete composed.parkCheckLastAttempt
  else composed.parkCheckLastAttempt = parkCheckLastAttempt
  return composed
}
