import {
    ATTACH_MESSAGE_MEDIA_RESULT_V1,
    parseAttachMessageMediaCommandV1,
    type AttachMessageMediaCommandV1,
    type AttachMessageMediaResultV1,
} from '../../../../contracts/messaging/v1'

export interface AttachMessageMediaPersistencePortV1 {
    attach(input: {
        messageId: string
        mediaType: string
        url: string
        fileName: string | null
        fileSize: number
        mimeType: string | null
    }): Promise<{ attachmentId: string }>
}

export function createAttachMessageMediaHandlerV1(port: AttachMessageMediaPersistencePortV1) {
    return async function attachMessageMediaV1(
        command: AttachMessageMediaCommandV1 | unknown,
    ): Promise<AttachMessageMediaResultV1> {
        const parsed = parseAttachMessageMediaCommandV1(command)
        const result = await port.attach({
            messageId: parsed.messageId,
            mediaType: parsed.mediaType,
            url: parsed.url,
            fileName: parsed.fileName,
            fileSize: parsed.fileSize,
            mimeType: parsed.mimeType,
        })
        return { contract: ATTACH_MESSAGE_MEDIA_RESULT_V1, attachmentId: result.attachmentId }
    }
}
