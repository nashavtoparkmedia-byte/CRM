import {
  DELETE_CONTACT_FOR_RETENTION_RESULT_V1,
  parseDeleteContactForRetentionCommandV1,
  type DeleteContactForRetentionCommandV1,
  type DeleteContactForRetentionResultV1,
} from '../../../../contracts/contacts/v1'

export interface ContactRetentionPersistencePortV1 {
  deleteContactForRetention(contactId: string): Promise<void>
}

export function createDeleteContactForRetentionHandlerV1(port: ContactRetentionPersistencePortV1) {
  return async function deleteContactForRetentionV1(
    command: DeleteContactForRetentionCommandV1 | unknown,
  ): Promise<DeleteContactForRetentionResultV1> {
    const parsed = parseDeleteContactForRetentionCommandV1(command)
    await port.deleteContactForRetention(parsed.contactId)
    return {
      contract: DELETE_CONTACT_FOR_RETENTION_RESULT_V1,
      completed: true,
    }
  }
}
