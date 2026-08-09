export const UPDATE_CONVERSATION_COMMAND_V1 = 'messaging.UpdateConversationCommand.v1' as const
export const UPDATE_CONVERSATION_RESULT_V1 = 'messaging.UpdateConversationResult.v1' as const
export const MARK_REQUIRES_RESPONSE_V1 = 'mark_requires_response' as const

export interface UpdateConversationCommandV1 {
    contract: typeof UPDATE_CONVERSATION_COMMAND_V1
    operation: typeof MARK_REQUIRES_RESPONSE_V1
    chatId: string
    lastMessageAt: string
}

export interface UpdateConversationResultV1 {
    contract: typeof UPDATE_CONVERSATION_RESULT_V1
    chatId: string
}

export class UpdateConversationValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: UpdateConversationValidationError['code'], message: string) {
        super(message)
        this.name = 'UpdateConversationValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'operation', 'chatId', 'lastMessageAt'])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new UpdateConversationValidationError('INVALID_CONTRACT', message)
}

export function parseUpdateConversationCommandV1(input: unknown): UpdateConversationCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== UPDATE_CONVERSATION_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('messaging.UpdateConversationCommand.')) {
            throw new UpdateConversationValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${UPDATE_CONVERSATION_COMMAND_V1}`)
    }
    if (input.operation !== MARK_REQUIRES_RESPONSE_V1) invalid('operation is invalid')
    if (typeof input.chatId !== 'string' || input.chatId.trim() === '') invalid('chatId is required')
    if (typeof input.lastMessageAt !== 'string' || !Number.isFinite(Date.parse(input.lastMessageAt))) {
        invalid('lastMessageAt must be an ISO date-time string')
    }
    return input as unknown as UpdateConversationCommandV1
}
