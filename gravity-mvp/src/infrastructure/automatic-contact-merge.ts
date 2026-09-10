import { MERGE_CONTACTS_COMMAND_V1 } from '@/contracts/contacts/v1'
import { ContactMergeErrorV1 } from '@/modules/contacts/public/v1/contact-merge-handler'
import { mergeContactsV1 } from './contact-merge-composition'

const AUTOMATION_ATTEMPT_V1 = {
  // These values are deliberately non-authoritative. Their presence marks an
  // automation attempt for the v1 command parser; the Contacts merge handler
  // re-derives all evidence from persisted state after CNT1 + pair locking.
  trustedUniqueCurrentPhone: false,
  phoneEvidenceRoot: null,
  confirmedPersonEvidenceRoots: [],
  normalizedVuEvidenceRoots: [],
} as const

export async function executeAutomaticContactMergeV1(input: {
  leftContactId: string
  rightContactId: string
}) {
  const contactIds = [...new Set([input.leftContactId, input.rightContactId])].sort()
  if (contactIds.length !== 2 || contactIds.some(contactId => !contactId.trim())) {
    return { status: 'invalid_pair' as const, reason: 'invalid_contact_pair' as const }
  }
  try {
    const result = await mergeContactsV1({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId: contactIds[0],
      targetId: contactIds[1],
      mergedBy: 'system:auto-merge',
      automation: AUTOMATION_ATTEMPT_V1,
    })
    if (result.status === 'automatic_merge_blocked') {
      return { status: 'policy_blocked' as const, reason: result.reason, result }
    }
    const survivorContactId = result.status === 'contact_merged'
      ? result.survivorId
      : result.status === 'already_merged' ? result.targetId : null
    if (!survivorContactId) {
      return { status: 'stale_pair' as const, reason: `unexpected_result:${result.status}` }
    }
    return { status: 'merged' as const, survivorContactId, result }
  } catch (error) {
    if (error instanceof ContactMergeErrorV1) {
      if (error.automaticBlockReason) {
        return {
          status: 'policy_blocked' as const,
          reason: error.automaticBlockReason,
          mergeErrorCode: error.code,
        }
      }
      if (['CONTACT_NOT_FOUND', 'CONTACT_ARCHIVED', 'SURVIVOR_ARCHIVED'].includes(error.code)) {
        return { status: 'stale_pair' as const, reason: error.code }
      }
      return { status: 'stale_pair' as const, reason: error.code }
    }
    throw error
  }
}
