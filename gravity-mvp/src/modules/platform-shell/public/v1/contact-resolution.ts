import {
  resolveChannelContactOperationV1 as resolveChannelContactOperationRawV1,
  resolveContactByPhoneV1 as resolveContactByPhoneRawV1,
  type ResolveChannelContactResultV1,
} from '@/modules/contacts/public/v1'
import { executeAutomaticContactMergeV1 } from '@/infrastructure/automatic-contact-merge'

type AutomaticContactMergeAttemptV1 = (input: {
  leftContactId: string
  rightContactId: string
}) => Promise<{ status: string }>

/** Platform composition; Contacts remains authoritative for both operations. */
export async function resolveWithAutomaticMergeV1(
  resolve: () => Promise<ResolveChannelContactResultV1>,
  attemptMerge: AutomaticContactMergeAttemptV1 = executeAutomaticContactMergeV1,
): Promise<ResolveChannelContactResultV1> {
  const first = await resolve()
  if (first.status !== 'ambiguous') return first
  const candidateContactIds = [...new Set(first.candidateContactIds)].sort()
  if (candidateContactIds.length !== 2) return first
  try {
    const attempt = await attemptMerge({
      leftContactId: candidateContactIds[0],
      rightContactId: candidateContactIds[1],
    })
    return attempt.status === 'merged' ? resolve() : first
  } catch (error) {
    console.error('[platform-shell] Optional automatic contact merge failed:', error)
    return first
  }
}

export const resolveChannelContactOperationV1 = (
  ...args: Parameters<typeof resolveChannelContactOperationRawV1>
) => resolveWithAutomaticMergeV1(() => resolveChannelContactOperationRawV1(...args))

export const resolveContactByPhoneV1 = (
  ...args: Parameters<typeof resolveContactByPhoneRawV1>
) => resolveWithAutomaticMergeV1(() => resolveContactByPhoneRawV1(...args))
