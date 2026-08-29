export const ATTACH_MESSAGE_MEDIA_COMMAND_V1 = 'messaging.AttachMessageMediaCommand.v1' as const
export const ATTACH_MESSAGE_MEDIA_RESULT_V1 = 'messaging.AttachMessageMediaResult.v1' as const

export interface AttachMessageMediaCommandV1 {
    contract: typeof ATTACH_MESSAGE_MEDIA_COMMAND_V1
    messageId: string
    mediaType: string
    url: string
    fileName: string | null
    fileSize: number
    mimeType: string | null
}

export interface AttachMessageMediaResultV1 {
    contract: typeof ATTACH_MESSAGE_MEDIA_RESULT_V1
    attachmentId: string
}

export class AttachMessageMediaValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: AttachMessageMediaValidationError['code'], message: string) {
        super(message)
        this.name = 'AttachMessageMediaValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'messageId', 'mediaType', 'url', 'fileName', 'fileSize', 'mimeType'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
function invalid(message: string): never {
    throw new AttachMessageMediaValidationError('INVALID_CONTRACT', message)
}

export function parseAttachMessageMediaCommandV1(input: unknown): AttachMessageMediaCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== ATTACH_MESSAGE_MEDIA_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('messaging.AttachMessageMediaCommand.')) {
            throw new AttachMessageMediaValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${ATTACH_MESSAGE_MEDIA_COMMAND_V1}`)
    }
    if (typeof input.messageId !== 'string' || input.messageId.trim() === '') invalid('messageId is required')
    if (typeof input.mediaType !== 'string' || input.mediaType.trim() === '') invalid('mediaType is required')
    if (typeof input.url !== 'string' || input.url === '') invalid('url is required')
    if (!isNullableString(input.fileName)) invalid('fileName must be a string or null')
    if (typeof input.fileSize !== 'number' || !Number.isInteger(input.fileSize) || input.fileSize < 0) {
        invalid('fileSize must be a non-negative integer')
    }
    if (!isNullableString(input.mimeType)) invalid('mimeType must be a string or null')
    return input as unknown as AttachMessageMediaCommandV1
}
