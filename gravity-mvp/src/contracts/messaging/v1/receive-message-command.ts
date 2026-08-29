export const RECEIVE_MESSAGE_COMMAND_V1 = 'messaging.ReceiveMessageCommand.v1' as const
export const RECEIVE_MESSAGE_RESULT_V1 = 'messaging.ReceiveMessageResult.v1' as const
export const RECEIVE_MESSAGE_CHANNELS_V1 = ['telegram', 'whatsapp', 'max', 'phone', 'avito'] as const
export type ReceiveMessageChannelV1 = typeof RECEIVE_MESSAGE_CHANNELS_V1[number]

export interface ReceiveMessageCommandV1 {
    contract: typeof RECEIVE_MESSAGE_COMMAND_V1
    chatId: string
    content: string
    sentAt: string
    externalId: string
    channel: ReceiveMessageChannelV1
    metadata: Record<string, unknown>
}

export interface ReceiveMessageResultV1 {
    contract: typeof RECEIVE_MESSAGE_RESULT_V1
    messageId: string
    created: boolean
}

export class ReceiveMessageValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ReceiveMessageValidationError['code'], message: string) {
        super(message)
        this.name = 'ReceiveMessageValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'chatId', 'content', 'sentAt', 'externalId', 'channel', 'metadata'])
const CHANNELS = new Set<string>(RECEIVE_MESSAGE_CHANNELS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new ReceiveMessageValidationError('INVALID_CONTRACT', message)
}

export function parseReceiveMessageCommandV1(input: unknown): ReceiveMessageCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== RECEIVE_MESSAGE_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('messaging.ReceiveMessageCommand.')) {
            throw new ReceiveMessageValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${RECEIVE_MESSAGE_COMMAND_V1}`)
    }
    if (typeof input.chatId !== 'string' || input.chatId.trim() === '') invalid('chatId is required')
    if (typeof input.content !== 'string' || input.content.trim() === '') invalid('content is required')
    if (typeof input.sentAt !== 'string' || !Number.isFinite(Date.parse(input.sentAt))) invalid('sentAt must be an ISO date-time string')
    if (typeof input.externalId !== 'string' || input.externalId.trim() === '') invalid('externalId is required')
    if (typeof input.channel !== 'string' || !CHANNELS.has(input.channel)) invalid('channel is invalid')
    if (!isRecord(input.metadata)) invalid('metadata must be an object')
    return input as unknown as ReceiveMessageCommandV1
}
