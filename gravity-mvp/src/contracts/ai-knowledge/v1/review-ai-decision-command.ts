export const REVIEW_AI_DECISION_COMMAND_V1 = 'ai_knowledge.ReviewAiDecisionCommand.v1' as const
export const REVIEW_AI_DECISION_RESULT_V1 = 'ai_knowledge.ReviewAiDecisionResult.v1' as const
export const AI_DECISION_VERDICTS_V1 = ['good', 'bad', 'fixed'] as const
export type AiDecisionVerdictV1 = typeof AI_DECISION_VERDICTS_V1[number]

export interface ReviewAiDecisionCommandV1 {
    contract: typeof REVIEW_AI_DECISION_COMMAND_V1
    logId: string
    verdict: AiDecisionVerdictV1
}
export interface ReviewAiDecisionResultV1 { contract: typeof REVIEW_AI_DECISION_RESULT_V1; reviewed: true }
export class ReviewAiDecisionValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: ReviewAiDecisionValidationError['code'], message: string) { super(message); this.name = 'ReviewAiDecisionValidationError'; this.code = code }
}
const FIELDS = new Set(['contract', 'logId', 'verdict']); const VERDICTS = new Set<string>(AI_DECISION_VERDICTS_V1)
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
function invalid(message: string): never { throw new ReviewAiDecisionValidationError('INVALID_CONTRACT', message) }
export function parseReviewAiDecisionCommandV1(input: unknown): ReviewAiDecisionCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const unexpected = Object.keys(input).filter((key) => !FIELDS.has(key)); if (unexpected.length) invalid(`unsupported command field(s): ${unexpected.sort().join(', ')}`)
    if (input.contract !== REVIEW_AI_DECISION_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('ai_knowledge.ReviewAiDecisionCommand.')) throw new ReviewAiDecisionValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        invalid(`contract must equal ${REVIEW_AI_DECISION_COMMAND_V1}`)
    }
    if (typeof input.logId !== 'string' || input.logId.trim() === '') invalid('logId is required')
    if (typeof input.verdict !== 'string' || !VERDICTS.has(input.verdict)) invalid('verdict is invalid')
    return input as unknown as ReviewAiDecisionCommandV1
}
