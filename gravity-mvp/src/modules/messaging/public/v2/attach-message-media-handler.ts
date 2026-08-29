import {
    ATTACH_MESSAGE_MEDIA_RESULT_V2,
    parseAttachMessageMediaCommandV2,
    type AttachMessageMediaCommandV2,
    type AttachMessageMediaResultV2,
} from '../../../../contracts/messaging/v2'

export interface AttachMessageMediaPersistencePortV2 {
    attach(input: {
        messageId: string
        mediaType: string
        url: string
        fileName: string | null
        fileSize: number | null
        mimeType: string | null
    }): Promise<{ attachmentId: string }>
}

export function createAttachMessageMediaHandlerV2(port: AttachMessageMediaPersistencePortV2) {
    return async function attachMessageMediaV2(
        command: AttachMessageMediaCommandV2 | unknown,
    ): Promise<AttachMessageMediaResultV2> {
        const parsed = parseAttachMessageMediaCommandV2(command)
        const result = await port.attach({
            messageId: parsed.messageId,
            mediaType: parsed.mediaType,
            url: parsed.url,
            fileName: parsed.fileName,
            fileSize: parsed.fileSize,
            mimeType: parsed.mimeType,
        })
        return { contract: ATTACH_MESSAGE_MEDIA_RESULT_V2, attachmentId: result.attachmentId }
    }
}
