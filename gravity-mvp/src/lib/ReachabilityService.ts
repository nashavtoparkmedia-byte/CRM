import type { ChatChannel } from '@prisma/client'

import {
  lockContactOwnershipRows,
  runContactOwnershipTransaction,
} from '@/modules/contacts/internal/contact-ownership-coordinator'
import { identityEvidenceState, jsonRecord } from '@/modules/contacts/public/v1/contact-evidence-state'

export type ExactReachabilityChannelV1 = Extract<ChatChannel, 'telegram' | 'whatsapp' | 'max'>
export type ExactReachabilityStatusV1 = 'confirmed' | 'unreachable'

export type RecordExactProviderReachabilityCommandV1 = {
  identityId: string
  contactId: string
  channel: ExactReachabilityChannelV1
  providerAccountId: string
  providerTargetId: string
  status: ExactReachabilityStatusV1
}

export type RecordExactProviderReachabilityResultV1 =
  | { outcome: 'updated'; identityId: string; status: ExactReachabilityStatusV1 }
  | { outcome: 'confirmed_preserved'; identityId: string; status: 'confirmed' }
  | {
      outcome: 'rejected'
      reason:
        | 'invalid_binding'
        | 'identity_not_found'
        | 'identity_inactive'
        | 'contact_owner_mismatch'
        | 'contact_archived'
        | 'channel_mismatch'
        | 'identity_conflicted'
        | 'provider_account_unproven'
        | 'provider_account_mismatch'
        | 'provider_target_mismatch'
        | 'persistence_error'
    }

function exactNonLegacyValue(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || value.trim() !== value) {
    return null
  }
  return value === 'legacy' ? null : value
}

function isExactReachabilityChannel(value: unknown): value is ExactReachabilityChannelV1 {
  return value === 'telegram' || value === 'whatsapp' || value === 'max'
}

function isExactReachabilityStatus(value: unknown): value is ExactReachabilityStatusV1 {
  return value === 'confirmed' || value === 'unreachable'
}

function hasOpenIdentityConflict(customFields: unknown, identityId: string): boolean {
  const conflicts = jsonRecord(customFields).identityConflicts
  return Array.isArray(conflicts) && conflicts.some(item => {
    const conflict = jsonRecord(item)
    return conflict.status === 'open' && conflict.identityId === identityId
  })
}

/**
 * Persist provider reachability only for one already-resolved ContactIdentity.
 *
 * The caller must carry all authority returned by the accepted provider path:
 * the exact Contact owner, identity id, provider account and opaque provider
 * target. Phone numbers are deliberately absent from this command: two people
 * may share a phone claim, and a phone lookup cannot authorize either identity.
 */
export async function recordExactProviderReachability(
  command: RecordExactProviderReachabilityCommandV1,
): Promise<RecordExactProviderReachabilityResultV1> {
  const identityId = exactNonLegacyValue(command?.identityId)
  const contactId = exactNonLegacyValue(command?.contactId)
  const providerAccountId = exactNonLegacyValue(command?.providerAccountId)
  const providerTargetId = exactNonLegacyValue(command?.providerTargetId)
  if (
    !identityId
    || !contactId
    || !providerAccountId
    || !providerTargetId
    || !isExactReachabilityChannel(command?.channel)
    || !isExactReachabilityStatus(command?.status)
  ) {
    return { outcome: 'rejected', reason: 'invalid_binding' }
  }

  try {
    let result: RecordExactProviderReachabilityResultV1 = {
      outcome: 'rejected',
      reason: 'persistence_error',
    }
    await runContactOwnershipTransaction(async transaction => {
      await lockContactOwnershipRows(transaction, {
        contactIds: [contactId],
        identityIds: [identityId],
      })

      const identity = await transaction.contactIdentity.findUnique({
        where: { id: identityId },
        select: {
          id: true,
          contactId: true,
          channel: true,
          externalId: true,
          isActive: true,
          metadata: true,
          reachabilityStatus: true,
          contact: {
            select: {
              id: true,
              isArchived: true,
              customFields: true,
            },
          },
        },
      })

      if (!identity) {
        result = { outcome: 'rejected', reason: 'identity_not_found' }
        return
      }
      if (!identity.isActive) {
        result = { outcome: 'rejected', reason: 'identity_inactive' }
        return
      }
      if (identity.contactId !== contactId || identity.contact.id !== contactId) {
        result = { outcome: 'rejected', reason: 'contact_owner_mismatch' }
        return
      }
      if (identity.contact.isArchived) {
        result = { outcome: 'rejected', reason: 'contact_archived' }
        return
      }
      if (identity.channel !== command.channel) {
        result = { outcome: 'rejected', reason: 'channel_mismatch' }
        return
      }
      if (
        identityEvidenceState(identity.metadata).conflictState === 'conflicted'
        || hasOpenIdentityConflict(identity.contact.customFields, identityId)
      ) {
        result = { outcome: 'rejected', reason: 'identity_conflicted' }
        return
      }

      const identityEvidence = identityEvidenceState(identity.metadata)
      const storedProviderAccountId = identityEvidence.providerAccountId
      if (storedProviderAccountId === 'legacy') {
        result = { outcome: 'rejected', reason: 'provider_account_unproven' }
        return
      }
      if (storedProviderAccountId !== providerAccountId) {
        result = { outcome: 'rejected', reason: 'provider_account_mismatch' }
        return
      }
      const exactProviderTargets = new Set([
        identity.externalId,
        ...identityEvidence.providerAliasValues,
      ])
      if (!exactProviderTargets.has(providerTargetId)) {
        result = { outcome: 'rejected', reason: 'provider_target_mismatch' }
        return
      }

      // A provider-side negative is weaker than direct inbound/delivery proof.
      // Keep the stronger fact while still returning an explicit outcome.
      if (command.status === 'unreachable' && identity.reachabilityStatus === 'confirmed') {
        result = { outcome: 'confirmed_preserved', identityId, status: 'confirmed' }
        return
      }

      await transaction.contactIdentity.update({
        where: { id: identityId },
        data: {
          reachabilityStatus: command.status,
          reachabilityCheckedAt: new Date(),
        },
      })
      result = { outcome: 'updated', identityId, status: command.status }
    })
    return result
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[ReachabilityService] Exact reachability persistence failed for ${identityId}: ${message}`)
    return { outcome: 'rejected', reason: 'persistence_error' }
  }
}
