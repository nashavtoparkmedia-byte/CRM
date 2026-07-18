import {
  ContactResolutionService,
  type ContactResolutionDb,
} from '@/lib/contacts/ContactResolutionService'
import type { ContactResolutionResult } from '@/lib/contacts/contact-resolution.types'

export type StrictPhoneOwnership =
  | { kind: 'not_found' }
  | { kind: 'matched'; contactId: string }
  | { kind: 'ambiguous'; contactIds: string[]; reason: ContactResolutionResult['status'] }

function sortedUnique(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export function mapStrictPhoneOwnership(result: ContactResolutionResult): StrictPhoneOwnership {
  switch (result.status) {
    case 'phone_matched':
    case 'merged_contact':
      return { kind: 'matched', contactId: result.canonicalContactId }
    case 'create_required':
      return { kind: 'not_found' }
    case 'ambiguous_phone':
      return {
        kind: 'ambiguous',
        contactIds: sortedUnique(result.candidateContactIds),
        reason: result.status,
      }
    case 'identity_phone_conflict':
      return {
        kind: 'ambiguous',
        contactIds: sortedUnique([result.identityContactId, ...result.phoneContactIds]),
        reason: result.status,
      }
    case 'archived_without_merge':
      return { kind: 'ambiguous', contactIds: [result.contactId], reason: result.status }
    case 'merge_cycle':
    case 'merge_ambiguous':
    case 'merge_depth_exceeded':
      return {
        kind: 'ambiguous',
        contactIds: sortedUnique(result.contactIds),
        reason: result.status,
      }
    case 'identity_found':
      return { kind: 'matched', contactId: result.canonicalContactId }
    case 'untrusted_phone':
    case 'invalid_input':
    case 'skipped_group':
      return { kind: 'ambiguous', contactIds: [], reason: result.status }
  }
}

/**
 * The one automatic phone-owner decision used by CRM write and routing paths.
 * The planner follows merge chains and returns an explicit 0 / 1 / 2+ result.
 */
export async function resolveStrictPhoneOwnership(
  db: ContactResolutionDb,
  normalizedPhone: string,
): Promise<StrictPhoneOwnership> {
  const result = await ContactResolutionService.fromDb(db).resolve({
    channel: 'whatsapp',
    normalizedPhone,
    phoneEvidence: {
      source: 'manual_verified',
      trustedForAutomaticResolution: true,
    },
    chatKind: 'private',
  })
  return mapStrictPhoneOwnership(result)
}
