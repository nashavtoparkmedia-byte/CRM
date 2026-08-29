import {
    DELETE_MESSAGE_MEDIA_RESULT_V1,
    parseDeleteMessageMediaCommandV1,
    type DeleteMessageMediaCommandV1,
    type DeleteMessageMediaResultV1,
} from '../../../../contracts/messaging/v1'

export interface DeleteMessageMediaPersistencePortV1 {
    deleteAllForMessage(input: { messageId: string }): Promise<{ deletedCount: number }>
}

export function createDeleteMessageMediaHandlerV1(port: DeleteMessageMediaPersistencePortV1) {
    return async function deleteMessageMediaV1(
        command: DeleteMessageMediaCommandV1 | unknown,
    ): Promise<DeleteMessageMediaResultV1> {
        const parsed = parseDeleteMessageMediaCommandV1(command)
        const result = await port.deleteAllForMessage({ messageId: parsed.messageId })
        return { contract: DELETE_MESSAGE_MEDIA_RESULT_V1, deletedCount: result.deletedCount }
    }
}
