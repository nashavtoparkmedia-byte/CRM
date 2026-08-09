export const QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1 = 'ai_knowledge.QueueKnowledgeExtractionCommand.v1' as const
export const QUEUE_KNOWLEDGE_EXTRACTION_RESULT_V1 = 'ai_knowledge.QueueKnowledgeExtractionResult.v1' as const
export const EXTRACTION_QUALITY_TIERS_V1 = ['economy', 'balanced', 'quality'] as const
export type ExtractionQualityTierV1 = typeof EXTRACTION_QUALITY_TIERS_V1[number]
export interface QueueKnowledgeExtractionCommandV1 { contract: typeof QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1; jobId: string; scopeJson: string; qualityTier: ExtractionQualityTierV1 }
export interface QueueKnowledgeExtractionResultV1 { contract: typeof QUEUE_KNOWLEDGE_EXTRACTION_RESULT_V1; queued: true }
export class QueueKnowledgeExtractionValidationError extends Error { readonly code: 'INVALID_CONTRACT'|'UNSUPPORTED_CONTRACT_VERSION'; constructor(code: QueueKnowledgeExtractionValidationError['code'], message: string) { super(message); this.name='QueueKnowledgeExtractionValidationError'; this.code=code } }
const FIELDS=new Set(['contract','jobId','scopeJson','qualityTier']),TIERS=new Set<string>(EXTRACTION_QUALITY_TIERS_V1);const isRecord=(v:unknown):v is Record<string,unknown>=>typeof v==='object'&&v!==null&&!Array.isArray(v);function invalid(m:string):never{throw new QueueKnowledgeExtractionValidationError('INVALID_CONTRACT',m)}
export function parseQueueKnowledgeExtractionCommandV1(input: unknown): QueueKnowledgeExtractionCommandV1 {
    if(!isRecord(input))invalid('command must be an object');const extra=Object.keys(input).filter(k=>!FIELDS.has(k));if(extra.length)invalid(`unsupported command field(s): ${extra.sort().join(', ')}`)
    if(input.contract!==QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1){if(typeof input.contract==='string'&&input.contract.startsWith('ai_knowledge.QueueKnowledgeExtractionCommand.'))throw new QueueKnowledgeExtractionValidationError('UNSUPPORTED_CONTRACT_VERSION',`unsupported contract version: ${input.contract}`);invalid(`contract must equal ${QUEUE_KNOWLEDGE_EXTRACTION_COMMAND_V1}`)}
    if(typeof input.jobId!=='string'||input.jobId.trim()==='')invalid('jobId is required');if(typeof input.scopeJson!=='string')invalid('scopeJson must be a JSON string');try{JSON.parse(input.scopeJson)}catch{invalid('scopeJson must be valid JSON')};if(typeof input.qualityTier!=='string'||!TIERS.has(input.qualityTier))invalid('qualityTier is invalid');return input as unknown as QueueKnowledgeExtractionCommandV1
}
