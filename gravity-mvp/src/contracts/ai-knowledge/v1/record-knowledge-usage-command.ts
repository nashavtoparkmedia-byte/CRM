export const RECORD_KNOWLEDGE_USAGE_COMMAND_V1 = 'ai_knowledge.RecordKnowledgeUsageCommand.v1' as const
export const RECORD_KNOWLEDGE_USAGE_RESULT_V1 = 'ai_knowledge.RecordKnowledgeUsageResult.v1' as const

export interface RecordKnowledgeUsageCommandV1 {
    contract: typeof RECORD_KNOWLEDGE_USAGE_COMMAND_V1
    id: string
    itemId: string
    decisionLogId: string
    messageId: string
    retrievalScore: number
    rerankScore: number | null
    usedInReply: boolean
    policyDecision: string
    shadowMode: boolean
    escalationReason: string | null
}

export interface RecordKnowledgeUsageResultV1 {
    contract: typeof RECORD_KNOWLEDGE_USAGE_RESULT_V1
    recorded: true
}

export class RecordKnowledgeUsageValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'

    constructor(code: RecordKnowledgeUsageValidationError['code'], message: string) {
        super(message)
        this.name = 'RecordKnowledgeUsageValidationError'
        this.code = code
    }
}

const FIELDS = new Set([
    'contract',
    'id',
    'itemId',
    'decisionLogId',
    'messageId',
    'retrievalScore',
    'rerankScore',
    'usedInReply',
    'policyDecision',
    'shadowMode',
    'escalationReason',
])
const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
const isNonEmptyString = (value: unknown): value is string =>
    typeof value === 'string' && value.trim() !== ''
const isNullableString = (value: unknown): value is string | null =>
    value === null || typeof value === 'string'
const isNullableFiniteNumber = (value: unknown): value is number | null =>
    value === null || (typeof value === 'number' && Number.isFinite(value))

function invalid(message: string): never {
    throw new RecordKnowledgeUsageValidationError('INVALID_CONTRACT', message)
}

export function parseRecordKnowledgeUsageCommandV1(input: unknown): RecordKnowledgeUsageCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== RECORD_KNOWLEDGE_USAGE_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('ai_knowledge.RecordKnowledgeUsageCommand.')) {
            throw new RecordKnowledgeUsageValidationError(
                'UNSUPPORTED_CONTRACT_VERSION',
                `unsupported contract version: ${input.contract}`,
            )
        }
        invalid(`contract must equal ${RECORD_KNOWLEDGE_USAGE_COMMAND_V1}`)
    }
    if (!isNonEmptyString(input.id)) invalid('id is required')
    if (!isNonEmptyString(input.itemId)) invalid('itemId is required')
    if (!isNonEmptyString(input.decisionLogId)) invalid('decisionLogId is required')
    if (!isNonEmptyString(input.messageId)) invalid('messageId is required')
    if (typeof input.retrievalScore !== 'number' || !Number.isFinite(input.retrievalScore)) {
        invalid('retrievalScore must be a finite number')
    }
    if (!isNullableFiniteNumber(input.rerankScore)) invalid('rerankScore must be a finite number or null')
    if (typeof input.usedInReply !== 'boolean') invalid('usedInReply must be a boolean')
    if (!isNonEmptyString(input.policyDecision)) invalid('policyDecision is required')
    if (typeof input.shadowMode !== 'boolean') invalid('shadowMode must be a boolean')
    if (!isNullableString(input.escalationReason)) invalid('escalationReason must be a string or null')
    return input as unknown as RecordKnowledgeUsageCommandV1
}
