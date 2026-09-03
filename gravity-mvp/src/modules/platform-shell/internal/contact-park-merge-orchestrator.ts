import { executeAutomaticContactMergeV1 } from '@/infrastructure/automatic-contact-merge'

/** Platform composition; the locked Contacts handler owns every decision. */
export function attemptAutomaticContactMergeFromPlatformV1(
  leftContactId: string,
  rightContactId: string,
) {
  return executeAutomaticContactMergeV1({ leftContactId, rightContactId })
}
