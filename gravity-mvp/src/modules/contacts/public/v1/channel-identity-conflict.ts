import { Prisma, type ChatChannel } from '@prisma/client'
import {
  assertContactOwnershipPostconditions,
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '../../internal/contact-ownership-coordinator'

export type MarkChannelIdentityConflictInputV1 = {
  contactId: string
  identityId: string
  channel: 'telegram' | 'whatsapp' | 'max'
  reason: string
  evidenceRoot: string
  details: Record<string, string | number | boolean | null>
}

function jsonRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function required(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '' || value.length > 1_024) {
    throw new TypeError(`${field} must be a bounded non-empty string`)
  }
}

function validate(input: MarkChannelIdentityConflictInputV1): void {
  required(input.contactId, 'contactId')
  required(input.identityId, 'identityId')
  required(input.reason, 'reason')
  required(input.evidenceRoot, 'evidenceRoot')
  if (!['telegram', 'whatsapp', 'max'].includes(input.channel)) {
    throw new TypeError('channel is invalid')
  }
}

/**
 * Marks the exact ContactIdentity linked by an admitted Chat as conflicted.
 * Existing outbound preparation and automatic-merge policy both consume this
 * Contacts-owned state and therefore fail closed after an ingress collision.
 */
export async function markChannelIdentityConflictV1(
  input: MarkChannelIdentityConflictInputV1,
): Promise<void> {
  validate(input)
  await runContactOwnershipTransaction(async transaction => {
    const scope = await lockContactOwnershipRows(transaction, {
      contactIds: [input.contactId],
      identityIds: [input.identityId],
    })
    const identity = await transaction.contactIdentity.findUnique({
      where: { id: input.identityId },
      select: {
        id: true,
        contactId: true,
        channel: true,
        externalId: true,
        isActive: true,
        metadata: true,
      },
    })
    const contact = await transaction.contact.findUnique({
      where: { id: input.contactId },
      select: { id: true, isArchived: true, customFields: true },
    })
    if (
      !identity
      || !identity.isActive
      || identity.contactId !== input.contactId
      || identity.channel !== (input.channel as ChatChannel)
      || !contact
      || contact.isArchived
    ) {
      throw new Error('CHANNEL_IDENTITY_CONFLICT_TARGET_MISMATCH')
    }

    const customFields = jsonRecord(contact.customFields)
    const conflicts = Array.isArray(customFields.identityConflicts)
      ? customFields.identityConflicts
      : []
    const duplicate = conflicts.some(item => {
      const conflict = jsonRecord(item)
      return conflict.status === 'open'
        && conflict.conflictType === 'channel_identity_collision'
        && conflict.identityId === identity.id
        && conflict.evidenceRoot === input.evidenceRoot
        && jsonRecord(conflict.details).reason === input.reason
    })
    if (!duplicate) {
      await transaction.contact.update({
        where: { id: contact.id },
        data: {
          customFields: {
            ...customFields,
            identityConflicts: [...conflicts, {
              otherContactIds: [],
              identityId: identity.id,
              conflictType: 'channel_identity_collision',
              evidenceRoot: input.evidenceRoot,
              source: 'channel-ingress',
              details: {
                ...input.details,
                channel: input.channel,
                reason: input.reason,
                externalUserId: identity.externalId,
              },
              detectedAt: new Date().toISOString(),
              status: 'open',
            }].slice(-100),
          } as Prisma.InputJsonObject,
        },
      })
    }

    const identityMetadata = jsonRecord(identity.metadata)
    if (identityMetadata.conflictState !== 'conflicted') {
      await transaction.contactIdentity.update({
        where: { id: identity.id },
        data: {
          metadata: {
            ...identityMetadata,
            conflictState: 'conflicted',
          } as Prisma.InputJsonObject,
        },
      })
    }
    await assertContactOwnershipPostconditions(transaction, scope)
  })
}
