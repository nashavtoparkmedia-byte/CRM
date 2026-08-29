export const DELETE_MESSAGE_MEDIA_COMMAND_V1 = 'messaging.DeleteMessageMediaCommand.v1' as const
export const DELETE_MESSAGE_MEDIA_RESULT_V1 = 'messaging.DeleteMessageMediaResult.v1' as const

export interface DeleteMessageMediaCommandV1 {
    contract: typeof DELETE_MESSAGE_MEDIA_COMMAND_V1
    messageId: string
}

export interface DeleteMessageMediaResultV1 {
    contract: typeof DELETE_MESSAGE_MEDIA_RESULT_V1
    deletedCount: number
}

export class DeleteMessageMediaValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: DeleteMessageMediaValidationError['code'], message: string) {
        super(message)
        this.name = 'DeleteMessageMediaValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'messageId'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new DeleteMessageMediaValidationError('INVALID_CONTRACT', message)
}

export function parseDeleteMessageMediaCommandV1(input: unknown): DeleteMessageMediaCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== DELETE_MESSAGE_MEDIA_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('messaging.DeleteMessageMediaCommand.')) {
            throw new DeleteMessageMediaValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${DELETE_MESSAGE_MEDIA_COMMAND_V1}`)
    }
    if (typeof input.messageId !== 'string' || input.messageId.trim() === '') invalid('messageId is required')
    return input as unknown as DeleteMessageMediaCommandV1
}
