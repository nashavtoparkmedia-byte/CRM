export const SEND_MESSAGE_COMMAND_V1 = 'messaging.SendMessageCommand.v1' as const
export const SEND_MESSAGE_RESULT_V1 = 'messaging.SendMessageResult.v1' as const
export const APPEND_SYSTEM_NOTIFICATION_V1 = 'append_system_notification' as const
export const SEND_MESSAGE_CHANNELS_V1 = ['telegram', 'whatsapp', 'max', 'phone', 'avito'] as const
export type SendMessageChannelV1 = typeof SEND_MESSAGE_CHANNELS_V1[number]

export interface SendMessageCommandV1 {
    contract: typeof SEND_MESSAGE_COMMAND_V1
    operation: typeof APPEND_SYSTEM_NOTIFICATION_V1
    chatId: string
    content: string
    sentAt: string
    externalId: string
    channel: SendMessageChannelV1
}

export interface SendMessageResultV1 {
    contract: typeof SEND_MESSAGE_RESULT_V1
    messageId: string
}

export class SendMessageValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: SendMessageValidationError['code'], message: string) {
        super(message)
        this.name = 'SendMessageValidationError'
        this.code = code
    }
}

const FIELDS = new Set(['contract', 'operation', 'chatId', 'content', 'sentAt', 'externalId', 'channel'])
const CHANNELS = new Set<string>(SEND_MESSAGE_CHANNELS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never {
    throw new SendMessageValidationError('INVALID_CONTRACT', message)
}

export function parseSendMessageCommandV1(input: unknown): SendMessageCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== SEND_MESSAGE_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('messaging.SendMessageCommand.')) {
            throw new SendMessageValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${SEND_MESSAGE_COMMAND_V1}`)
    }
    if (input.operation !== APPEND_SYSTEM_NOTIFICATION_V1) invalid('operation is invalid')
    if (typeof input.chatId !== 'string' || input.chatId.trim() === '') invalid('chatId is required')
    if (typeof input.content !== 'string' || input.content.trim() === '') invalid('content is required')
    if (typeof input.sentAt !== 'string' || !Number.isFinite(Date.parse(input.sentAt))) invalid('sentAt must be an ISO date-time string')
    if (typeof input.externalId !== 'string' || input.externalId.trim() === '') invalid('externalId is required')
    if (typeof input.channel !== 'string' || !CHANNELS.has(input.channel)) invalid('channel is invalid')
    return input as unknown as SendMessageCommandV1
}
