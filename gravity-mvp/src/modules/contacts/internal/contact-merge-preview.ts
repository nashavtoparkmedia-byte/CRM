// The handler behind contacts.ContactMergePreviewQuery.v1: the two Contacts as
// the merge loads them, and the merge's own survivor policy over them. It never
// merges, locks or writes. The caller has already passed Contacts' read
// authority.
import {
  CONTACT_MERGE_PREVIEW_RESULT_V1,
  CONTACT_MERGE_SURVIVOR_REASONS_V1,
  parseContactMergePreviewQueryV1,
  type ContactMergePreviewResultV1,
  type ContactMergeSurvivorReasonV1,
} from '@/contracts/contacts/v1'
import { evaluateManualMergeSurvivorV1, type ContactMergeSourceV1 } from '../public/v1/contact-merge-handler'

export type ContactMergePreviewSourcePortV1 = (sourceId: string, targetId: string) => Promise<{
  source: ContactMergeSourceV1 | null
  target: ContactMergeSourceV1 | null
}>

function unavailable(reason: Extract<ContactMergePreviewResultV1, { status: 'unavailable' }>['reason']): ContactMergePreviewResultV1 {
  return { contract: CONTACT_MERGE_PREVIEW_RESULT_V1, status: 'unavailable', reason }
}

export function createContactMergePreviewHandlerV1(readSources: ContactMergePreviewSourcePortV1) {
  return async function previewContactMergeV1(query: unknown): Promise<ContactMergePreviewResultV1> {
    const parsed = parseContactMergePreviewQueryV1(query)
    if (parsed.sourceContactId === parsed.targetContactId) return unavailable('same_contact')
    const { source, target } = await readSources(parsed.sourceContactId, parsed.targetContactId)
    if (source === null || target === null) return unavailable('missing')
    if (source.isArchived || target.isArchived) return unavailable('archived')
    if (source.doNotMerge || target.doNotMerge) return unavailable('merge_forbidden')
    const evaluation = evaluateManualMergeSurvivorV1(source, target)
    const known = new Set<string>(CONTACT_MERGE_SURVIVOR_REASONS_V1)
    return {
      contract: CONTACT_MERGE_PREVIEW_RESULT_V1,
      status: 'previewed',
      survivorContactId: evaluation.survivorId,
      mergedContactId: evaluation.mergedId,
      reasons: evaluation.orderedReasons.filter((reason): reason is ContactMergeSurvivorReasonV1 => known.has(reason)),
    }
  }
}
