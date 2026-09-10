import {
  MERGE_CONTACTS_COMMAND_V1,
  type MergeContactsResultV1,
} from '@/contracts/contacts/v1'
import {
  ContactMergeErrorV1,
  type ContactMergeErrorCodeV1,
} from '@/modules/contacts/public/v1'
import { mergeContactsV1 } from '@/infrastructure/contact-merge-composition'

export type MergeErrorCode = ContactMergeErrorCodeV1
export { ContactMergeErrorV1 as MergeError }

export type MergeResult =
  | { status: 'already_linked'; contactId: string; driverId: string }
  | { status: 'linked'; contactId: string; driverId: string }
  | { status: 'merged'; survivorId: string; mergedId: string; driverId: string; mergeRecordId: string }
  | { status: 'already_merged'; sourceId: string; targetId: string }
  | { status: 'contact_merged'; survivorId: string; mergedId: string; mergeRecordId: string }
  | { status: 'automatic_merge_blocked'; leftContactId: string; rightContactId: string; reason: string }

function stripContract(result: MergeContactsResultV1): MergeResult {
  switch (result.status) {
    case 'already_linked':
      return { status: result.status, contactId: result.contactId, driverId: result.driverId }
    case 'linked':
      return { status: result.status, contactId: result.contactId, driverId: result.driverId }
    case 'merged':
      return {
        status: result.status,
        survivorId: result.survivorId,
        mergedId: result.mergedId,
        driverId: result.driverId,
        mergeRecordId: result.mergeRecordId,
      }
    case 'already_merged':
      return { status: result.status, sourceId: result.sourceId, targetId: result.targetId }
    case 'contact_merged':
      return {
        status: result.status,
        survivorId: result.survivorId,
        mergedId: result.mergedId,
        mergeRecordId: result.mergeRecordId,
      }
    case 'automatic_merge_blocked':
      return {
        status: result.status,
        leftContactId: result.leftContactId,
        rightContactId: result.rightContactId,
        reason: result.reason,
      }
  }
}

export class ContactMergeService {
  static async mergeContactToDriver(
    _contactId: string,
    _driverId: string,
    _mergedBy: string = 'system',
  ): Promise<MergeResult> {
    throw new ContactMergeErrorV1(
      'DRIVER_PERSON_CONFIRMATION_REQUIRED',
      'Contact to Driver attachment requires canonical all-park person confirmation',
    )
  }

  static async mergeContactToContact(
    sourceId: string,
    targetId: string,
    mergedBy: string = 'system',
  ): Promise<MergeResult> {
    return stripContract(await mergeContactsV1({
      contract: MERGE_CONTACTS_COMMAND_V1,
      operation: 'contact_to_contact',
      sourceId,
      targetId,
      mergedBy,
    }))
  }
}
