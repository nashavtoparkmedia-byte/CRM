export const RECORD_AI_DECISION_COMMAND_V1 = 'ai_knowledge.RecordAiDecisionCommand.v1' as const
export const RECORD_AI_DECISION_RESULT_V1 = 'ai_knowledge.RecordAiDecisionResult.v1' as const
export const AI_DECISIONS_V1 = ['auto_reply', 'escalate', 'skip'] as const
export type AiDecisionV1 = typeof AI_DECISIONS_V1[number]

export interface RecordAiDecisionCommandV1 {
    contract: typeof RECORD_AI_DECISION_COMMAND_V1
    id: string
    messageId: string
    chatId: string
    channel: string
    detectedIntent: string
    confidence: number
    decision: AiDecisionV1
    selectedModel: string
    usedKnowledgeEntriesJson: string
    generatedReply: string | null
    replySent: boolean
    escalated: boolean
    error: string | null
    retrievalMode: string | null
    retrievalDecision: string | null
    escalationReason: string | null
    knowledgeRuntimeVersion: string | null
    shadowRetrievalSummaryJson: string | null
}

export interface RecordAiDecisionResultV1 {
    contract: typeof RECORD_AI_DECISION_RESULT_V1
    recorded: true
}

export class RecordAiDecisionValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: RecordAiDecisionValidationError['code'], message: string) {
        super(message); this.name = 'RecordAiDecisionValidationError'; this.code = code
    }
}

const FIELDS = new Set(['contract', 'id', 'messageId', 'chatId', 'channel', 'detectedIntent', 'confidence', 'decision', 'selectedModel', 'usedKnowledgeEntriesJson', 'generatedReply', 'replySent', 'escalated', 'error', 'retrievalMode', 'retrievalDecision', 'escalationReason', 'knowledgeRuntimeVersion', 'shadowRetrievalSummaryJson'])
const DECISIONS = new Set<string>(AI_DECISIONS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== ''
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
function invalid(message: string): never { throw new RecordAiDecisionValidationError('INVALID_CONTRACT', message) }
function validJson(value: unknown, nullable: boolean): boolean {
    if (nullable && value === null) return true
    if (typeof value !== 'string') return false
    try { JSON.parse(value); return true } catch { return false }
}

export function parseRecordAiDecisionCommandV1(input: unknown): RecordAiDecisionCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key))
    if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== RECORD_AI_DECISION_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('ai_knowledge.RecordAiDecisionCommand.')) {
            throw new RecordAiDecisionValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        }
        invalid(`contract must equal ${RECORD_AI_DECISION_COMMAND_V1}`)
    }
    for (const field of ['id', 'messageId', 'chatId', 'channel', 'detectedIntent', 'selectedModel']) {
        if (!nonEmpty(input[field])) invalid(`${field} is required`)
    }
    if (typeof input.confidence !== 'number' || !Number.isFinite(input.confidence)) invalid('confidence must be finite')
    if (typeof input.decision !== 'string' || !DECISIONS.has(input.decision)) invalid('decision is invalid')
    if (!validJson(input.usedKnowledgeEntriesJson, false)) invalid('usedKnowledgeEntriesJson must be valid JSON')
    if (!validJson(input.shadowRetrievalSummaryJson, true)) invalid('shadowRetrievalSummaryJson must be valid JSON or null')
    for (const field of ['generatedReply', 'error', 'retrievalMode', 'retrievalDecision', 'escalationReason', 'knowledgeRuntimeVersion']) {
        if (!nullableString(input[field])) invalid(`${field} must be a string or null`)
    }
    if (typeof input.replySent !== 'boolean' || typeof input.escalated !== 'boolean') invalid('replySent and escalated must be booleans')
    return input as unknown as RecordAiDecisionCommandV1
}
