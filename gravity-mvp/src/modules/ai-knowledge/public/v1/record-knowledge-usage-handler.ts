import {
    RECORD_KNOWLEDGE_USAGE_RESULT_V1,
    parseRecordKnowledgeUsageCommandV1,
    type RecordKnowledgeUsageCommandV1,
    type RecordKnowledgeUsageResultV1,
} from '../../../../contracts/ai-knowledge/v1'

export interface RecordKnowledgeUsagePersistencePortV1 {
    append(input: Omit<RecordKnowledgeUsageCommandV1, 'contract'>): Promise<void>
}

export function createRecordKnowledgeUsageHandlerV1(port: RecordKnowledgeUsagePersistencePortV1) {
    return async function recordKnowledgeUsageV1(
        command: RecordKnowledgeUsageCommandV1 | unknown,
    ): Promise<RecordKnowledgeUsageResultV1> {
        const parsed = parseRecordKnowledgeUsageCommandV1(command)
        await port.append({
            id: parsed.id,
            itemId: parsed.itemId,
            decisionLogId: parsed.decisionLogId,
            messageId: parsed.messageId,
            retrievalScore: parsed.retrievalScore,
            rerankScore: parsed.rerankScore,
            usedInReply: parsed.usedInReply,
            policyDecision: parsed.policyDecision,
            shadowMode: parsed.shadowMode,
            escalationReason: parsed.escalationReason,
        })
        return { contract: RECORD_KNOWLEDGE_USAGE_RESULT_V1, recorded: true }
    }
}
