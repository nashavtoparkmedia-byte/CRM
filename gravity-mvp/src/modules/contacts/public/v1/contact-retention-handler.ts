import {
  DELETE_CONTACT_FOR_RETENTION_RESULT_V1,
  ContactRetentionEligibilityChangedError,
  parseDeleteContactForRetentionCommandV1,
  type DeleteContactForRetentionCommandV1,
  type DeleteContactForRetentionResultV1,
} from '../../../../contracts/contacts/v1'

export interface ContactRetentionPersistencePortV1 {
  deleteContactForRetention(contactId: string): Promise<'deleted' | 'missing' | 'ineligible'>
}

export function createDeleteContactForRetentionHandlerV1(port: ContactRetentionPersistencePortV1) {
  return async function deleteContactForRetentionV1(
    command: DeleteContactForRetentionCommandV1 | unknown,
  ): Promise<DeleteContactForRetentionResultV1> {
    const parsed = parseDeleteContactForRetentionCommandV1(command)
    const outcome = await port.deleteContactForRetention(parsed.contactId)
    if (outcome === 'ineligible') throw new ContactRetentionEligibilityChangedError()
    return {
      contract: DELETE_CONTACT_FOR_RETENTION_RESULT_V1,
      completed: true,
    }
  }
}
