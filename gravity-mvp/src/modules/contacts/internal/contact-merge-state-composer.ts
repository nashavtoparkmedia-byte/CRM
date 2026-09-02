import { contactAutomationState, jsonRecord } from '../public/v1/contact-evidence-state'

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
        sourceFields.identityConflicts,
        targetFields.identityConflicts,
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
