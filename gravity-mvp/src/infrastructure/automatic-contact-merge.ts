import { prisma } from '@/lib/prisma'
import { MERGE_CONTACTS_COMMAND_V1 } from '@/contracts/contacts/v1'
import {
  evaluateAutomaticContactMergeV1,
  type AutomaticMergeEvidenceV1,
  type ContactAutomationSnapshotV1,
} from '@/modules/contacts/public/v1/contact-automation-policy'
import { mergeContactsV1 } from './contact-merge-composition'
import { contactAutomationState } from '@/modules/contacts/public/v1/contact-evidence-state'

async function snapshot(contactId: string): Promise<ContactAutomationSnapshotV1 | null> {
  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    include: {
      identities: { where: { isActive: true }, select: { source: true } },
      tasks: { where: { isActive: true }, select: { id: true, status: true, assigneeId: true } },
      calls: { select: { id: true } },
      chats: { select: { id: true, _count: { select: { messages: true } } } },
    },
  })
  if (!contact) return null
  const customFields = contact.customFields && typeof contact.customFields === 'object' && !Array.isArray(contact.customFields)
    ? contact.customFields as Record<string, unknown>
    : null
  const confirmations = Array.isArray(customFields?.driverConfirmations)
    ? customFields.driverConfirmations.filter(item => (
        item && typeof item === 'object' && !Array.isArray(item)
        && (item as Record<string, unknown>).status === 'confirmed'
      )) as Array<Record<string, unknown>>
    : []
  const conflicts = Array.isArray(customFields?.identityConflicts)
    ? customFields.identityConflicts.filter(item => (
        item && typeof item === 'object' && !Array.isArray(item)
        && (item as Record<string, unknown>).status === 'open'
      )) as Array<Record<string, unknown>>
    : []
  const automation = contactAutomationState(contact.customFields)
  return {
    id: contact.id,
    createdAt: contact.createdAt,
    canonicalPinned: Boolean(automation.canonicalPinnedAt),
    doNotMerge: automation.doNotMerge,
    isArchived: contact.isArchived,
    notes: contact.notes,
    tags: contact.tags,
    customFields,
    manualIdentityCount: contact.identities.filter(identity => identity.source === 'manual').length,
    driverRelationshipCount: contact.yandexDriverId ? 1 : 0,
    activeTaskCount: contact.tasks.length,
    callCount: contact.calls.length,
    chatCount: contact.chats.length,
    messageCount: contact.chats.reduce((sum, chat) => sum + chat._count.messages, 0),
    confirmedDriver: confirmations.length > 0,
    confirmedPersonKeys: confirmations
      .map(item => item.profileClusterKey)
      .filter((key): key is string => typeof key === 'string'),
    workflowKeys: contact.tasks.map(task => `task:${task.status}:${task.assigneeId ?? 'unassigned'}`),
    openConflictTypes: [
      ...conflicts
        .map(conflict => conflict.conflictType)
        .filter((type): type is string => typeof type === 'string'),
      ...(automation.mergeRecoveryState && automation.mergeRecoveryState !== 'clear'
        ? [`merge_recovery_${automation.mergeRecoveryState}`]
        : []),
    ],
  }
}

export async function executeAutomaticContactMergeV1(input: {
  leftContactId: string
  rightContactId: string
  evidence: AutomaticMergeEvidenceV1
}) {
  const [left, right] = await Promise.all([snapshot(input.leftContactId), snapshot(input.rightContactId)])
  if (!left || !right) return { status: 'blocked' as const, reason: 'contact_not_found' }
  const decision = evaluateAutomaticContactMergeV1(left, right, input.evidence)
  if (decision.decision === 'blocked') return { status: 'blocked' as const, reason: decision.reason }
  const result = await mergeContactsV1({
    contract: MERGE_CONTACTS_COMMAND_V1,
    operation: 'contact_to_contact',
    sourceId: decision.survivor.mergedId,
    targetId: decision.survivor.survivorId,
    mergedBy: 'system:auto-merge',
    automation: input.evidence,
  })
  return { status: 'merged' as const, decision, result }
}
