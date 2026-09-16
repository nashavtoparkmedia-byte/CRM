export type ContactAutomationSnapshotV1 = {
  id: string
  createdAt: Date
  displayName: string
  displayNameSource: string | null
  masterSource: string | null
  yandexDriverId: string | null
  mainDriverId: string | null
  mainDriverSelection: string | null
  canonicalPinned: boolean
  doNotMerge: boolean
  isArchived: boolean
  notes: string | null
  tags: string[]
  customFields: Record<string, unknown> | null
  manualIdentityCount: number
  driverRelationshipCount: number
  activeTaskCount: number
  callCount: number
  chatCount: number
  messageCount: number
  confirmedDriver: boolean
  confirmedPersonKeys: string[]
  workflowKeys: string[]
  openConflictTypes: string[]
}

export type ContactClassificationV1 = {
  kind: 'channel_only' | 'substantive'
  reasons: string[]
}

const CONTACT_SYSTEM_EVIDENCE_FIELDS = new Set([
  'automaticMergeBlocks',
  'canonicalPinnedAt',
  'canonicalPinnedBy',
  'confirmedDriverClusterKeys',
  'doNotMerge',
  'driverConfirmations',
  'identityConflicts',
  'mergeRecoveryState',
  'mergedIntoContactId',
  'parkCheckLastAttempt',
  'parkCheckResult',
  'phoneEvidenceByPhoneId',
])

const KNOWN_DISPLAY_NAME_SOURCES = new Set(['channel', 'yandex', 'manual'])
const KNOWN_MASTER_SOURCES = new Set(['chat', 'yandex', 'manual'])

function hasBusinessCustomFields(customFields: Record<string, unknown> | null): boolean {
  return Boolean(customFields && Object.keys(customFields).some(key => !CONTACT_SYSTEM_EVIDENCE_FIELDS.has(key)))
}

function stableValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableValue(record[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? String(value)
}

function meaningfulBusinessValue(value: unknown): boolean {
  return value !== null && value !== undefined && (typeof value !== 'string' || Boolean(value.trim()))
}

function hasCompetingBusinessState(
  left: ContactAutomationSnapshotV1,
  right: ContactAutomationSnapshotV1,
): boolean {
  if (left.notes?.trim() && right.notes?.trim() && left.notes.trim() !== right.notes.trim()) return true
  if (left.canonicalPinned && right.canonicalPinned) return true
  const leftManualIdentity = left.displayNameSource === 'manual' || left.masterSource === 'manual'
  const rightManualIdentity = right.displayNameSource === 'manual' || right.masterSource === 'manual'
  if (leftManualIdentity !== rightManualIdentity) return true
  if (leftManualIdentity && rightManualIdentity
    && left.displayName.trim() !== right.displayName.trim()) return true
  if (left.mainDriverId && right.mainDriverId
    && (left.mainDriverId !== right.mainDriverId
      || left.mainDriverSelection !== right.mainDriverSelection)) return true
  if (left.yandexDriverId && right.yandexDriverId && left.yandexDriverId !== right.yandexDriverId) return true
  const leftFields = left.customFields ?? {}
  const rightFields = right.customFields ?? {}
  for (const key of Object.keys(leftFields)) {
    if (CONTACT_SYSTEM_EVIDENCE_FIELDS.has(key) || !(key in rightFields)) continue
    if (!meaningfulBusinessValue(leftFields[key]) && !meaningfulBusinessValue(rightFields[key])) continue
    if (stableValue(leftFields[key]) !== stableValue(rightFields[key])) return true
  }
  return false
}

export function classifyContactForAutomationV1(
  contact: ContactAutomationSnapshotV1,
): ContactClassificationV1 {
  const reasons: string[] = []
  if (contact.displayNameSource === 'manual' || contact.masterSource === 'manual') {
    reasons.push('manually_curated_identity')
  }
  if (!KNOWN_DISPLAY_NAME_SOURCES.has(contact.displayNameSource ?? '')
    || !KNOWN_MASTER_SOURCES.has(contact.masterSource ?? '')) {
    reasons.push('unknown_identity_source')
  }
  if (contact.canonicalPinned) reasons.push('manual_canonical_pin')
  if (contact.doNotMerge) reasons.push('do_not_merge')
  if (contact.confirmedDriver) reasons.push('confirmed_driver')
  if (contact.driverRelationshipCount > 0) reasons.push('driver_relationship')
  if (contact.mainDriverId || contact.mainDriverSelection === 'manual') reasons.push('main_driver_selection')
  if (contact.manualIdentityCount > 0) reasons.push('manual_identity')
  if (contact.activeTaskCount > 0) reasons.push('active_work')
  if (contact.callCount > 0) reasons.push('call_history')
  if (contact.notes?.trim()) reasons.push('manual_notes')
  if (contact.tags.length > 0) reasons.push('manual_tags')
  if (hasBusinessCustomFields(contact.customFields)) reasons.push('business_fields')
  if (contact.workflowKeys.length > 0) reasons.push('workflow_state')
  if (contact.openConflictTypes.length > 0) reasons.push('unresolved_conflict')
  return reasons.length > 0
    ? { kind: 'substantive', reasons }
    : { kind: 'channel_only', reasons: ['provider_ingress_only'] }
}

export type SurvivorEvaluationV1 = {
  survivorId: string
  mergedId: string
  orderedReasons: string[]
}

function compareBoolean(left: boolean, right: boolean): number {
  return left === right ? 0 : left ? -1 : 1
}

export function evaluateContactSurvivorV1(
  left: ContactAutomationSnapshotV1,
  right: ContactAutomationSnapshotV1,
): SurvivorEvaluationV1 {
  const leftClass = classifyContactForAutomationV1(left)
  const rightClass = classifyContactForAutomationV1(right)
  const comparisons: Array<[string, number]> = [
    ['manual_canonical_pin', compareBoolean(left.canonicalPinned, right.canonicalPinned)],
    ['substantive_contact', leftClass.kind === rightClass.kind ? 0 : leftClass.kind === 'substantive' ? -1 : 1],
    ['current_workflows', right.workflowKeys.length - left.workflowKeys.length],
    ['richer_history', (right.activeTaskCount + right.callCount + right.chatCount + right.messageCount)
      - (left.activeTaskCount + left.callCount + left.chatCount + left.messageCount)],
    ['confirmed_physical_driver', compareBoolean(left.confirmedDriver, right.confirmedDriver)],
    ['older_contact', left.createdAt.getTime() - right.createdAt.getTime()],
    ['immutable_id', left.id.localeCompare(right.id)],
  ]
  const winner = comparisons.find(([, value]) => value !== 0)
  const leftWins = !winner || winner[1] < 0
  return {
    survivorId: leftWins ? left.id : right.id,
    mergedId: leftWins ? right.id : left.id,
    orderedReasons: comparisons
      .filter(([, value]) => value !== 0)
      .map(([reason]) => reason),
  }
}

export type AutomaticMergeEvidenceV1 = {
  trustedUniqueCurrentPhone: boolean
  phoneEvidenceRoot: string | null
  confirmedPersonEvidenceRoots: string[]
  confirmedPersonKeys?: string[]
  normalizedVuEvidenceRoots: string[]
}

export type AutomaticMergeDecisionV1 =
  | { decision: 'merge'; survivor: SurvivorEvaluationV1; evidenceRoots: string[] }
  | { decision: 'blocked'; reason: string }

export function evaluateAutomaticContactMergeV1(
  left: ContactAutomationSnapshotV1,
  right: ContactAutomationSnapshotV1,
  evidence: AutomaticMergeEvidenceV1,
): AutomaticMergeDecisionV1 {
  if (left.isArchived || right.isArchived) return { decision: 'blocked', reason: 'archived_contact' }
  if (left.doNotMerge || right.doNotMerge) return { decision: 'blocked', reason: 'do_not_merge' }
  if (left.openConflictTypes.length > 0 || right.openConflictTypes.length > 0) {
    return { decision: 'blocked', reason: 'hard_conflict' }
  }
  const workflowCollision = left.workflowKeys.some(key => right.workflowKeys.includes(key))
    || (left.workflowKeys.length > 0 && right.workflowKeys.length > 0)
  if (workflowCollision) return { decision: 'blocked', reason: 'workflow_collision' }

  const leftClass = classifyContactForAutomationV1(left)
  const rightClass = classifyContactForAutomationV1(right)
  if (leftClass.kind === 'substantive' && rightClass.kind === 'substantive'
    && hasCompetingBusinessState(left, right)) {
    return { decision: 'blocked', reason: 'business_state_collision' }
  }
  const leftConfirmedPersonKeys = [...new Set(left.confirmedPersonKeys)].sort()
  const rightConfirmedPersonKeys = [...new Set(right.confirmedPersonKeys)].sort()
  const evidenceConfirmedPersonKeys = [...new Set(evidence.confirmedPersonKeys ?? [])].sort()
  const nonemptyContactKeySets = [leftConfirmedPersonKeys, rightConfirmedPersonKeys]
    .filter(keys => keys.length > 0)
  const bothContactsHaveKeys = nonemptyContactKeySets.length === 2
  const contactsHaveIncompatibleKeys = bothContactsHaveKeys
    && (leftConfirmedPersonKeys.length !== rightConfirmedPersonKeys.length
      || leftConfirmedPersonKeys.some((key, index) => key !== rightConfirmedPersonKeys[index]))
  const oneContactHasAmbiguousKeys = nonemptyContactKeySets.length === 1
    && nonemptyContactKeySets[0].length !== 1
  if (contactsHaveIncompatibleKeys || oneContactHasAmbiguousKeys) {
    return { decision: 'blocked', reason: 'confirmed_person_key_mismatch' }
  }
  const suppliedConfirmedPersonEvidence = evidenceConfirmedPersonKeys.length > 0
    || evidence.confirmedPersonEvidenceRoots.length > 0
  const suppliedConfirmedPersonKey = evidenceConfirmedPersonKeys.length === 1
    ? evidenceConfirmedPersonKeys[0]
    : null
  const consistentSuppliedConfirmation = Boolean(
    suppliedConfirmedPersonKey
    && evidence.confirmedPersonEvidenceRoots.length > 0
    && nonemptyContactKeySets.length > 0
    && nonemptyContactKeySets.every(keys => (
      keys.length === 1 && keys[0] === suppliedConfirmedPersonKey
    )),
  )
  if ((suppliedConfirmedPersonEvidence && !consistentSuppliedConfirmation)
    || (bothContactsHaveKeys && !consistentSuppliedConfirmation)) {
    return { decision: 'blocked', reason: 'confirmed_person_key_mismatch' }
  }
  const sameConfirmedPerson = suppliedConfirmedPersonEvidence && consistentSuppliedConfirmation
  const independentStrongRoots = new Set([
    ...evidence.confirmedPersonEvidenceRoots,
    ...evidence.normalizedVuEvidenceRoots,
  ])
  if (evidence.phoneEvidenceRoot) independentStrongRoots.delete(evidence.phoneEvidenceRoot)

  if (leftClass.kind === 'substantive' && rightClass.kind === 'substantive') {
    if (!sameConfirmedPerson || independentStrongRoots.size === 0) {
      return { decision: 'blocked', reason: 'substantive_phone_only' }
    }
  } else if (!evidence.trustedUniqueCurrentPhone && !sameConfirmedPerson) {
    return { decision: 'blocked', reason: 'insufficient_evidence' }
  }

  const roots = new Set<string>()
  if (evidence.trustedUniqueCurrentPhone && evidence.phoneEvidenceRoot) roots.add(evidence.phoneEvidenceRoot)
  for (const root of independentStrongRoots) roots.add(root)
  if (sameConfirmedPerson) {
    for (const root of evidence.confirmedPersonEvidenceRoots) roots.add(root)
  }
  if (roots.size === 0) return { decision: 'blocked', reason: 'circular_or_missing_evidence' }

  return {
    decision: 'merge',
    survivor: evaluateContactSurvivorV1(left, right),
    evidenceRoots: [...roots].sort(),
  }
}
