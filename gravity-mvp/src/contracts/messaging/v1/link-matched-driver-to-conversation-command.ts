export const LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1 =
    'messaging.LinkMatchedDriverToConversationCommand.v1' as const
export const LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1 =
    'messaging.LinkMatchedDriverToConversationResult.v1' as const

export interface LinkMatchedDriverToConversationCommandV1 {
    contract: typeof LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1
    chatId: string
    driverId: string
}

export interface LinkMatchedDriverToConversationResultV1 {
    contract: typeof LINK_MATCHED_DRIVER_TO_CONVERSATION_RESULT_V1
    /** True only when the conversation is already linked to, or was safely linked to, this driver. */
    linked: boolean
}

export class LinkMatchedDriverToConversationValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: LinkMatchedDriverToConversationValidationError['code'], message: string) {
        super(message)
        this.name = 'LinkMatchedDriverToConversationValidationError'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new LinkMatchedDriverToConversationValidationError('INVALID_CONTRACT', message)
}

export function parseLinkMatchedDriverToConversationCommandV1(
    input: unknown,
): LinkMatchedDriverToConversationCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const allowedFields = new Set(['contract', 'chatId', 'driverId'])
    const unexpected = Object.keys(input).filter((key) => !allowedFields.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1) {
        if (
            typeof input.contract === 'string'
            && input.contract.startsWith('messaging.LinkMatchedDriverToConversationCommand.')
        ) {
            throw new LinkMatchedDriverToConversationValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${LINK_MATCHED_DRIVER_TO_CONVERSATION_COMMAND_V1}`)
    }
    if (typeof input.chatId !== 'string' || input.chatId.trim() === '') invalid('chatId is required')
    if (typeof input.driverId !== 'string' || input.driverId.trim() === '') invalid('driverId is required')
    return input as unknown as LinkMatchedDriverToConversationCommandV1
}
