export const UPSERT_PROPOSED_REPLY_COMMAND_V1 = 'ai_knowledge.UpsertProposedReplyCommand.v1' as const
export const UPSERT_PROPOSED_REPLY_RESULT_V1 = 'ai_knowledge.UpsertProposedReplyResult.v1' as const
export const PATCH_PROPOSED_REPLY_COMMAND_V1 = 'ai_knowledge.PatchProposedReplyCommand.v1' as const
export const PATCH_PROPOSED_REPLY_RESULT_V1 = 'ai_knowledge.PatchProposedReplyResult.v1' as const

export type ProposedReplyDecisionModeV1 = 'auto_reply' | 'escalate' | 'no_match'

export interface UpsertProposedReplyCommandV1 {
    contract: typeof UPSERT_PROPOSED_REPLY_COMMAND_V1
    messageId: string
    chatId: string
    text: string
    confidence: number
    decisionMode: ProposedReplyDecisionModeV1
    reasoning: string | null
    sources: unknown | null
    expiresAt: Date
}

export interface UpsertProposedReplyResultV1 {
    contract: typeof UPSERT_PROPOSED_REPLY_RESULT_V1
    proposal: unknown
}

export interface ProposedReplyPatchV1 {
    takenAt?: Date
    sentMessageId?: string
    dismissedAt?: Date
    confirmedCorrectAt?: Date
}

export interface PatchProposedReplyCommandV1 {
    contract: typeof PATCH_PROPOSED_REPLY_COMMAND_V1
    proposalId: string
    patch: ProposedReplyPatchV1
}

export interface PatchProposedReplyResultV1 {
    contract: typeof PATCH_PROPOSED_REPLY_RESULT_V1
    updated: true
}

export class ProposedReplyCommandValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: ProposedReplyCommandValidationError['code'], message: string) {
        super(message)
        this.name = 'ProposedReplyCommandValidationError'
        this.code = code
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

function invalid(message: string): never {
    throw new ProposedReplyCommandValidationError('INVALID_CONTRACT', message)
}

function envelope(input: unknown, expected: string, prefix: string, fields: string[]): Record<string, unknown> {
    if (!isRecord(input)) invalid('command must be an object')
    const extra = Object.keys(input).filter((key) => !fields.includes(key))
    if (extra.length) invalid(`unsupported field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== expected) {
        if (typeof input.contract === 'string' && input.contract.startsWith(prefix)) {
            throw new ProposedReplyCommandValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${expected}`)
    }
    return input
}

function requiredString(value: unknown, key: string): void {
    if (typeof value !== 'string' || value.trim() === '') invalid(`${key} is required`)
}

export function parseUpsertProposedReplyCommandV1(input: unknown): UpsertProposedReplyCommandV1 {
    const value = envelope(input, UPSERT_PROPOSED_REPLY_COMMAND_V1, 'ai_knowledge.UpsertProposedReplyCommand.', [
        'contract', 'messageId', 'chatId', 'text', 'confidence', 'decisionMode', 'reasoning', 'sources', 'expiresAt',
    ])
    requiredString(value.messageId, 'messageId')
    requiredString(value.chatId, 'chatId')
    if (typeof value.text !== 'string') invalid('text must be a string')
    if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence)) invalid('confidence must be finite')
    if (!['auto_reply', 'escalate', 'no_match'].includes(value.decisionMode as string)) invalid('decisionMode is invalid')
    if (value.reasoning !== null && typeof value.reasoning !== 'string') invalid('reasoning must be a string or null')
    if (!(value.expiresAt instanceof Date) || Number.isNaN(value.expiresAt.getTime())) invalid('expiresAt must be a valid Date')
    return value as unknown as UpsertProposedReplyCommandV1
}

export function parsePatchProposedReplyCommandV1(input: unknown): PatchProposedReplyCommandV1 {
    const value = envelope(input, PATCH_PROPOSED_REPLY_COMMAND_V1, 'ai_knowledge.PatchProposedReplyCommand.', [
        'contract', 'proposalId', 'patch',
    ])
    requiredString(value.proposalId, 'proposalId')
    if (!isRecord(value.patch)) invalid('patch must be an object')
    const fields = ['takenAt', 'sentMessageId', 'dismissedAt', 'confirmedCorrectAt']
    const extra = Object.keys(value.patch).filter((key) => !fields.includes(key))
    if (extra.length) invalid(`unsupported patch field(s): ${extra.sort().join(', ')}`)
    if (Object.keys(value.patch).length === 0) invalid('patch must not be empty')
    for (const key of ['takenAt', 'dismissedAt', 'confirmedCorrectAt']) {
        const candidate = value.patch[key]
        if (candidate !== undefined && (!(candidate instanceof Date) || Number.isNaN(candidate.getTime()))) invalid(`patch.${key} must be a valid Date`)
    }
    if (value.patch.sentMessageId !== undefined) requiredString(value.patch.sentMessageId, 'patch.sentMessageId')
    return value as unknown as PatchProposedReplyCommandV1
}
