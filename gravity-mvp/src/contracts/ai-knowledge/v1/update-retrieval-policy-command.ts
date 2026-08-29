export const UPDATE_RETRIEVAL_POLICY_COMMAND_V1 = 'ai_knowledge.UpdateRetrievalPolicyCommand.v1' as const
export const UPDATE_RETRIEVAL_POLICY_RESULT_V1 = 'ai_knowledge.UpdateRetrievalPolicyResult.v1' as const

export interface UpdateRetrievalPolicyPatchV1 {
    minConfidenceForReply?: number
    sensitiveConfidenceMargin?: number
    minSourceCountForReply?: number
    verifiedScoreBoost?: number
    excludeArchived?: boolean
    excludeSuperseded?: boolean
    excludeDraft?: boolean
    conflictEscalates?: boolean
    rerankEnabled?: boolean
    rerankTopN?: number
    prefilterTopN?: number
}
export interface UpdateRetrievalPolicyCommandV1 { contract: typeof UPDATE_RETRIEVAL_POLICY_COMMAND_V1; actorId: string; patch: UpdateRetrievalPolicyPatchV1 }
export interface UpdateRetrievalPolicyResultV1 { contract: typeof UPDATE_RETRIEVAL_POLICY_RESULT_V1; updated: boolean }
export class UpdateRetrievalPolicyValidationError extends Error {
    readonly code: 'INVALID_CONTRACT' | 'UNSUPPORTED_CONTRACT_VERSION'
    constructor(code: UpdateRetrievalPolicyValidationError['code'], message: string) { super(message); this.name = 'UpdateRetrievalPolicyValidationError'; this.code = code }
}
export const RETRIEVAL_POLICY_FIELDS_V1 = ['minConfidenceForReply', 'sensitiveConfidenceMargin', 'minSourceCountForReply', 'verifiedScoreBoost', 'excludeArchived', 'excludeSuperseded', 'excludeDraft', 'conflictEscalates', 'rerankEnabled', 'rerankTopN', 'prefilterTopN'] as const
const INTEGER_FIELDS = new Set(['minSourceCountForReply', 'rerankTopN', 'prefilterTopN'])
const BOOLEAN_FIELDS = new Set(['excludeArchived', 'excludeSuperseded', 'excludeDraft', 'conflictEscalates', 'rerankEnabled'])
const FIELDS = new Set<string>(RETRIEVAL_POLICY_FIELDS_V1); const ENVELOPE = new Set(['contract', 'actorId', 'patch'])
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
function invalid(message: string): never { throw new UpdateRetrievalPolicyValidationError('INVALID_CONTRACT', message) }
export function parseUpdateRetrievalPolicyCommandV1(input: unknown): UpdateRetrievalPolicyCommandV1 {
    if (!isRecord(input)) invalid('command must be an object')
    const extra = Object.keys(input).filter(k => !ENVELOPE.has(k)); if (extra.length) invalid(`unsupported command field(s): ${extra.sort().join(', ')}`)
    if (input.contract !== UPDATE_RETRIEVAL_POLICY_COMMAND_V1) {
        if (typeof input.contract === 'string' && input.contract.startsWith('ai_knowledge.UpdateRetrievalPolicyCommand.')) throw new UpdateRetrievalPolicyValidationError('UNSUPPORTED_CONTRACT_VERSION', `unsupported contract version: ${input.contract}`)
        invalid(`contract must equal ${UPDATE_RETRIEVAL_POLICY_COMMAND_V1}`)
    }
    if (typeof input.actorId !== 'string' || input.actorId.trim() === '') invalid('actorId is required')
    if (!isRecord(input.patch)) invalid('patch must be an object')
    const unsupported = Object.keys(input.patch).filter(k => !FIELDS.has(k)); if (unsupported.length) invalid(`unsupported patch field(s): ${unsupported.sort().join(', ')}`)
    for (const [field, value] of Object.entries(input.patch)) {
        if (value === undefined) continue
        if (BOOLEAN_FIELDS.has(field)) { if (typeof value !== 'boolean') invalid(`${field} must be a boolean`); continue }
        if (typeof value !== 'number' || !Number.isFinite(value)) invalid(`${field} must be a finite number`)
        if (INTEGER_FIELDS.has(field) && !Number.isInteger(value)) invalid(`${field} must be an integer`)
    }
    return input as unknown as UpdateRetrievalPolicyCommandV1
}
