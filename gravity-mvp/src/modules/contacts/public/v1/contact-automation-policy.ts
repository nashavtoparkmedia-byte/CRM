export type ContactAutomationSnapshotV1 = {
  id: string
  createdAt: Date
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
  'canonicalPinnedAt',
  'canonicalPinnedBy',
  'confirmedDriverClusterKeys',
  'doNotMerge',
  'driverConfirmations',
  'identityConflicts',
  'mergeRecoveryState',
  'mergedIntoContactId',
  'phoneEvidenceByPhoneId',
])

function hasBusinessCustomFields(customFields: Record<string, unknown> | null): boolean {
  return Boolean(customFields && Object.keys(customFields).some(key => !CONTACT_SYSTEM_EVIDENCE_FIELDS.has(key)))
}

export function classifyContactForAutomationV1(
  contact: ContactAutomationSnapshotV1,
): ContactClassificationV1 {
  const reasons: string[] = []
  if (contact.canonicalPinned) reasons.push('manual_canonical_pin')
  if (contact.doNotMerge) reasons.push('do_not_merge')
  if (contact.confirmedDriver) reasons.push('confirmed_driver')
  if (contact.driverRelationshipCount > 0) reasons.push('driver_relationship')
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
  const sameConfirmedPerson = left.confirmedPersonKeys.some(key => right.confirmedPersonKeys.includes(key))
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
