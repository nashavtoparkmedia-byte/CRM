// contacts.ContactMergePreviewQuery.v1 — which Contact a manual merge of two
// Contacts would keep, decided by the merge's own survivor policy, without
// merging (Contact Identity V2, Owner mandate §7.1: the merge dialog shows the
// result of the policy in force, never a choice made by the open page).
//
// Read-only. It names two exact Contact ids and answers the survivor and the
// policy reasons that decided it, or why no merge of the pair is possible now.
export const CONTACT_MERGE_PREVIEW_QUERY_V1 = 'contacts.ContactMergePreviewQuery.v1' as const
export const CONTACT_MERGE_PREVIEW_RESULT_V1 = 'contacts.ContactMergePreviewResult.v1' as const

/** The survivor policy's own reason codes, in the order it compares them. */
export const CONTACT_MERGE_SURVIVOR_REASONS_V1 = [
  'manual_canonical_pin',
  'substantive_contact',
  'current_workflows',
  'richer_history',
  'confirmed_physical_driver',
  'older_contact',
  'immutable_id',
] as const
export type ContactMergeSurvivorReasonV1 = typeof CONTACT_MERGE_SURVIVOR_REASONS_V1[number]

export type ContactMergePreviewQueryV1 = {
  contract: typeof CONTACT_MERGE_PREVIEW_QUERY_V1
  sourceContactId: string
  targetContactId: string
}

export type ContactMergePreviewUnavailableReasonV1 = 'same_contact' | 'missing' | 'archived' | 'merge_forbidden'

export type ContactMergePreviewResultV1 =
  | {
      contract: typeof CONTACT_MERGE_PREVIEW_RESULT_V1
      status: 'previewed'
      survivorContactId: string
      mergedContactId: string
      /** The decisive reason first; only reasons the policy actually compared unequal. */
      reasons: ContactMergeSurvivorReasonV1[]
    }
  | { contract: typeof CONTACT_MERGE_PREVIEW_RESULT_V1; status: 'unavailable'; reason: ContactMergePreviewUnavailableReasonV1 }

export class ContactMergePreviewQueryValidationError extends Error {
  readonly code = 'INVALID_CONTRACT' as const
  constructor(message: string) {
    super(message)
    this.name = 'ContactMergePreviewQueryValidationError'
  }
}

function exactId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128 || value.trim() !== value) {
    throw new ContactMergePreviewQueryValidationError(`${field} must be an exact Contact id`)
  }
  return value
}

export function parseContactMergePreviewQueryV1(input: unknown): ContactMergePreviewQueryV1 {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ContactMergePreviewQueryValidationError('query must be an object')
  const value = input as Record<string, unknown>
  const extra = Object.keys(value).filter(key => key !== 'contract' && key !== 'sourceContactId' && key !== 'targetContactId')
  if (extra.length > 0) throw new ContactMergePreviewQueryValidationError(`unsupported field(s): ${extra.sort().join(', ')}`)
  if (value.contract !== CONTACT_MERGE_PREVIEW_QUERY_V1) throw new ContactMergePreviewQueryValidationError(`contract must equal ${CONTACT_MERGE_PREVIEW_QUERY_V1}`)
  return {
    contract: CONTACT_MERGE_PREVIEW_QUERY_V1,
    sourceContactId: exactId(value.sourceContactId, 'sourceContactId'),
    targetContactId: exactId(value.targetContactId, 'targetContactId'),
  }
}
