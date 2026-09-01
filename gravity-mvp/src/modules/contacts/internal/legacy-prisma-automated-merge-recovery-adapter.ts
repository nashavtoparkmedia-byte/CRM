import { Prisma } from '@prisma/client'

import {
  admitContactOwnershipTransaction,
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  type ContactOwnershipLockedScope,
} from './contact-ownership-coordinator'
import type {
  AutomatedMergeRecoveryContactsRepositoryV1,
  AutomatedMergeRecoveryPlanV1,
} from '../public/v1/automated-contact-merge-recovery'
import {
  contactAutomationState,
  jsonRecord,
} from '../public/v1/contact-evidence-state'

type PhoneSnapshot = { id: string; isActive: boolean; isPrimary: boolean }
type ContactSnapshot = {
  contact: {
    id: string
    displayName: string
    displayNameSource: string
    masterSource: string
    yandexDriverId: string | null
    mainDriverId: string | null
    mainDriverSelection: string
    mainDriverSelectedBy: string | null
    mainDriverSelectedAt: string | null
    primaryPhoneId: string | null
    notes: string | null
    tags: string[]
    doNotMerge: boolean
    customFields: unknown
  }
  phones: PhoneSnapshot[]
  identities: Array<{ id: string }>
  chatIds: string[]
  taskIds: string[]
  callIds: string[]
  driverProfileIds: string[]
}
type RecoverySnapshot = ContactSnapshot & { survivorBefore: ContactSnapshot | null }
type MergeRecoveryMetadata = {
  automated: boolean
  recoveryState: string
  evidenceRoots?: unknown
  survivorEvaluation?: unknown
  recoveryRequestedAt?: string
  recoveredAt?: string
  recoveredBy?: string
  recoveryBasis?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function parseSnapshot(value: Prisma.JsonValue): RecoverySnapshot | null {
  if (!isRecord(value) || !isRecord(value.contact) || !isRecord(value.survivorBefore)) return null
  const survivorBefore = value.survivorBefore
  const requiredArrays = ['phones', 'identities', 'chatIds', 'taskIds', 'callIds', 'driverProfileIds']
  if (!requiredArrays.every(key => Array.isArray(value[key]))) return null
  if (!requiredArrays.every(key => Array.isArray(survivorBefore[key]))) return null
  return value as unknown as RecoverySnapshot
}

function mergeMetadata(value: Prisma.JsonValue): MergeRecoveryMetadata {
  const metadata = jsonRecord(jsonRecord(value)._merge)
  return {
    ...metadata,
    automated: metadata.automated === true,
    recoveryState: typeof metadata.recoveryState === 'string' ? metadata.recoveryState : 'clear',
  } as MergeRecoveryMetadata
}

function withMergeMetadata(
  value: Prisma.JsonValue,
  patch: Partial<MergeRecoveryMetadata>,
): Prisma.InputJsonObject {
  const snapshot = jsonRecord(value)
  return {
    ...snapshot,
    _merge: { ...mergeMetadata(value), ...patch },
  } as Prisma.InputJsonObject
}

function stateFields(value: unknown): Record<string, unknown> {
  const fields = { ...jsonRecord(value) }
  delete fields.mergedIntoContactId
  delete fields.mergeRecoveryState
  return fields
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sameIds(actual: string[], expected: string[]): boolean {
  return [...actual].sort().join('\u0000') === [...expected].sort().join('\u0000')
}

function expectedComposedPrimary(source: ContactSnapshot, survivor: ContactSnapshot): string | null {
  const survivorPrimary = survivor.contact.primaryPhoneId
  if (survivorPrimary && survivor.phones.some(phone => phone.id === survivorPrimary && phone.isActive)) {
    return survivorPrimary
  }
  return [...survivor.phones, ...source.phones]
    .filter(phone => phone.isActive)
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary) || left.id.localeCompare(right.id))[0]?.id
    ?? null
}

function expectedComposedContact(source: ContactSnapshot, survivor: ContactSnapshot) {
  const sourceFields = isRecord(source.contact.customFields) ? source.contact.customFields : {}
  const survivorFields = isRecord(survivor.contact.customFields) ? survivor.contact.customFields : {}
  const sourcePhones = jsonRecord(sourceFields.phoneEvidenceByPhoneId)
  const survivorPhones = jsonRecord(survivorFields.phoneEvidenceByPhoneId)
  return {
    displayName: survivor.contact.displayName,
    displayNameSource: survivor.contact.displayNameSource,
    masterSource: survivor.contact.masterSource,
    yandexDriverId: survivor.contact.yandexDriverId ?? source.contact.yandexDriverId,
    mainDriverId: survivor.contact.mainDriverId ?? source.contact.mainDriverId,
    mainDriverSelection: !survivor.contact.mainDriverId && source.contact.mainDriverId
      ? source.contact.mainDriverSelection
      : survivor.contact.mainDriverSelection,
    mainDriverSelectedBy: !survivor.contact.mainDriverId && source.contact.mainDriverId
      ? source.contact.mainDriverSelectedBy
      : survivor.contact.mainDriverSelectedBy,
    mainDriverSelectedAt: !survivor.contact.mainDriverId && source.contact.mainDriverId
      ? source.contact.mainDriverSelectedAt
      : survivor.contact.mainDriverSelectedAt,
    notes: survivor.contact.notes || source.contact.notes,
    tags: [...new Set([...survivor.contact.tags, ...source.contact.tags])],
    doNotMerge: survivor.contact.doNotMerge || source.contact.doNotMerge,
    customFields: {
      ...sourceFields,
      ...survivorFields,
      doNotMerge: survivor.contact.doNotMerge || source.contact.doNotMerge,
      phoneEvidenceByPhoneId: { ...sourcePhones, ...survivorPhones },
    },
    primaryPhoneId: expectedComposedPrimary(source, survivor),
  }
}

export function makePrismaAutomatedMergeRecoveryContactsRepositoryV1(
  transaction: Prisma.TransactionClient,
): AutomatedMergeRecoveryContactsRepositoryV1 {
  let lockedScope: ContactOwnershipLockedScope | null = null
  let recoveryPlan: AutomatedMergeRecoveryPlanV1 | null = null
  return {
    admitOwnershipMutation: () => admitContactOwnershipTransaction(transaction),

    async discoverPair(mergeId) {
      return transaction.contactMerge.findUnique({
        where: { id: mergeId },
        select: { mergedId: true, survivorId: true },
      })
    },

    async lockPair(mergedId, survivorId) {
      lockedScope = await lockContactOwnershipRows(transaction, {
        contactIds: [mergedId, survivorId],
        mergeIds: [],
      })
    },

    async inspect(mergeId) {
      const merge = await transaction.contactMerge.findUnique({
        where: { id: mergeId },
        include: {
          merged: { include: { identities: true, phones: true } },
          survivor: { include: { identities: true, phones: true } },
        },
      })
      if (!merge) return { status: 'blocked', reason: 'merge_not_found' }
      const metadata = mergeMetadata(merge.snapshotBefore)
      if (!metadata.automated) return { status: 'blocked', reason: 'manual_merge' }
      if (!['recoverable', 'recovery_requested'].includes(metadata.recoveryState)) {
        return { status: 'blocked', reason: `recovery_state_${metadata.recoveryState}` }
      }
      const snapshot = parseSnapshot(merge.snapshotBefore)
      if (!snapshot?.survivorBefore) return { status: 'blocked', reason: 'legacy_snapshot_incomplete' }
      if (!merge.merged.isArchived
        || contactAutomationState(merge.merged.customFields).mergedIntoContactId !== merge.survivorId) {
        return { status: 'blocked', reason: 'loser_redirect_changed' }
      }
      if (merge.merged.identities.length > 0 || merge.merged.phones.length > 0) {
        return { status: 'blocked', reason: 'loser_received_new_identity_state' }
      }

      const sourceIdentityIds = snapshot.identities.map(identity => identity.id)
      const survivorIdentityIds = snapshot.survivorBefore.identities.map(identity => identity.id)
      const sourcePhoneIds = snapshot.phones.map(phone => phone.id)
      const survivorPhoneIds = snapshot.survivorBefore.phones.map(phone => phone.id)
      if (!sameIds(merge.survivor.identities.map(identity => identity.id), [
        ...sourceIdentityIds,
        ...survivorIdentityIds,
      ])) return { status: 'blocked', reason: 'identity_set_changed_or_deduplicated' }
      if (!sameIds(merge.survivor.phones.map(phone => phone.id), [
        ...sourcePhoneIds,
        ...survivorPhoneIds,
      ])) return { status: 'blocked', reason: 'phone_set_changed_or_deduplicated' }

      const composed = expectedComposedContact(snapshot, snapshot.survivorBefore)
      if (merge.survivor.isArchived
        || merge.survivor.displayName !== composed.displayName
        || merge.survivor.displayNameSource !== composed.displayNameSource
        || merge.survivor.masterSource !== composed.masterSource
        || merge.survivor.yandexDriverId !== composed.yandexDriverId
        || merge.survivor.mainDriverId !== composed.mainDriverId
        || merge.survivor.mainDriverSelection !== composed.mainDriverSelection
        || merge.survivor.mainDriverSelectedBy !== composed.mainDriverSelectedBy
        || (merge.survivor.mainDriverSelectedAt?.toISOString() ?? null) !== composed.mainDriverSelectedAt
        || merge.survivor.notes !== composed.notes
        || !sameIds(merge.survivor.tags, composed.tags)
        || contactAutomationState(merge.survivor.customFields).doNotMerge !== composed.doNotMerge
        || stableJson(stateFields(merge.survivor.customFields)) !== stableJson(stateFields(composed.customFields))
        || merge.survivor.primaryPhoneId !== composed.primaryPhoneId) {
        return { status: 'blocked', reason: 'survivor_contact_state_changed' }
      }
      const selectedPrimary = composed.primaryPhoneId
      if (merge.survivor.phones.some(phone => phone.isPrimary !== (phone.id === selectedPrimary))) {
        return { status: 'blocked', reason: 'primary_phone_state_changed' }
      }

      recoveryPlan = {
        mergeId,
        mergedId: merge.mergedId,
        survivorId: merge.survivorId,
        identityIds: sourceIdentityIds,
        phoneIds: sourcePhoneIds,
        chatIds: snapshot.chatIds,
        taskIds: snapshot.taskIds,
        callIds: snapshot.callIds,
        driverProfileIds: snapshot.driverProfileIds,
      }
      return { status: 'eligible', plan: recoveryPlan }
    },

    async restore(plan) {
      const merge = await transaction.contactMerge.findUnique({ where: { id: plan.mergeId } })
      if (!merge) throw new Error('RECOVERY_MERGE_MISSING')
      const snapshot = parseSnapshot(merge.snapshotBefore)
      if (!snapshot?.survivorBefore) throw new Error('RECOVERY_SNAPSHOT_INVALID')

      await transaction.contactIdentity.updateMany({
        where: { id: { in: plan.identityIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      await transaction.contactPhone.updateMany({
        where: { id: { in: plan.phoneIds }, contactId: plan.survivorId },
        data: { contactId: plan.mergedId },
      })
      for (const phone of [...snapshot.phones, ...snapshot.survivorBefore.phones]) {
        await transaction.contactPhone.update({
          where: { id: phone.id },
          data: { isPrimary: phone.isPrimary },
        })
      }
      const restoreContact = async (contactSnapshot: ContactSnapshot, archived: boolean) => {
        await transaction.contact.update({
          where: { id: contactSnapshot.contact.id },
          data: {
            displayName: contactSnapshot.contact.displayName,
            displayNameSource: contactSnapshot.contact.displayNameSource as never,
            masterSource: contactSnapshot.contact.masterSource as never,
            yandexDriverId: contactSnapshot.contact.yandexDriverId,
            mainDriverId: contactSnapshot.contact.mainDriverId,
            mainDriverSelection: contactSnapshot.contact.mainDriverSelection,
            mainDriverSelectedBy: contactSnapshot.contact.mainDriverSelectedBy,
            mainDriverSelectedAt: contactSnapshot.contact.mainDriverSelectedAt
              ? new Date(contactSnapshot.contact.mainDriverSelectedAt)
              : null,
            primaryPhoneId: contactSnapshot.contact.primaryPhoneId,
            notes: contactSnapshot.contact.notes,
            tags: contactSnapshot.contact.tags,
            customFields: {
              ...jsonRecord(contactSnapshot.contact.customFields),
              doNotMerge: contactSnapshot.contact.doNotMerge,
            } as Prisma.InputJsonObject,
            isArchived: archived,
          },
        })
      }
      await restoreContact(snapshot.survivorBefore, false)
      await restoreContact(snapshot, false)
      if (lockedScope) {
        lockedScope = {
          ...lockedScope,
          identityIds: [...new Set([...lockedScope.identityIds, ...plan.identityIds])],
          phoneIds: [...new Set([...lockedScope.phoneIds, ...plan.phoneIds])],
        }
      }
    },

    async markManualReconciliation(input) {
      const current = await transaction.contactMerge.findUnique({
        where: { id: input.mergeId },
        select: { mergedId: true, survivorId: true, snapshotBefore: true },
      })
      if (!current) throw new Error('RECOVERY_MERGE_MISSING')
      const now = new Date().toISOString()
      const merge = await transaction.contactMerge.update({
        where: { id: input.mergeId },
        data: {
          snapshotBefore: withMergeMetadata(current.snapshotBefore, {
            recoveryState: 'manual_reconciliation',
            recoveryRequestedAt: now,
            recoveredBy: input.requestedBy,
            recoveryBasis: `${input.basis}; blocked:${input.reason}`,
          }),
        },
        select: { mergedId: true, survivorId: true },
      })
      for (const contactId of [merge.mergedId, merge.survivorId]) {
        const contact = await transaction.contact.findUnique({ where: { id: contactId }, select: { customFields: true } })
        await transaction.contact.update({
          where: { id: contactId },
          data: {
            customFields: {
              ...jsonRecord(contact?.customFields),
              mergeRecoveryState: 'manual_reconciliation',
            } as Prisma.InputJsonObject,
          },
        })
      }
    },

    async markRecovered(input) {
      const current = await transaction.contactMerge.findUnique({
        where: { id: input.mergeId },
        select: { snapshotBefore: true },
      })
      if (!current) throw new Error('RECOVERY_MERGE_MISSING')
      const now = new Date().toISOString()
      await transaction.contactMerge.update({
        where: { id: input.mergeId },
        data: {
          snapshotBefore: withMergeMetadata(current.snapshotBefore, {
            recoveryState: 'recovered',
            recoveryRequestedAt: now,
            recoveredAt: now,
            recoveredBy: input.requestedBy,
            recoveryBasis: input.basis,
          }),
        },
      })
      for (const contactId of [input.mergedId, input.survivorId]) {
        const contact = await transaction.contact.findUnique({ where: { id: contactId }, select: { customFields: true } })
        const fields = { ...jsonRecord(contact?.customFields) }
        delete fields.mergeRecoveryState
        delete fields.mergedIntoContactId
        await transaction.contact.update({
          where: { id: contactId },
          data: { customFields: fields as Prisma.InputJsonObject },
        })
      }
    },

    async verifyPostconditions() {
      if (!lockedScope || !recoveryPlan) throw new Error('RECOVERY_NOT_LOCKED')
      await assertContactOwnershipPostconditions(transaction, lockedScope)
    },
  }
}
