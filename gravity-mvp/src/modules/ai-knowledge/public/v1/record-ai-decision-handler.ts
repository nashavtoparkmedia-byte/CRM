import { RECORD_AI_DECISION_RESULT_V1, parseRecordAiDecisionCommandV1, type RecordAiDecisionCommandV1, type RecordAiDecisionResultV1 } from '../../../../contracts/ai-knowledge/v1'

export interface RecordAiDecisionPersistencePortV1 { append(input: Omit<RecordAiDecisionCommandV1, 'contract'>): Promise<void> }
export function createRecordAiDecisionHandlerV1(port: RecordAiDecisionPersistencePortV1) {
    return async function recordAiDecisionV1(command: RecordAiDecisionCommandV1 | unknown): Promise<RecordAiDecisionResultV1> {
        const parsed = parseRecordAiDecisionCommandV1(command)
        await port.append({
            id: parsed.id,
            messageId: parsed.messageId,
            chatId: parsed.chatId,
            channel: parsed.channel,
            detectedIntent: parsed.detectedIntent,
            confidence: parsed.confidence,
            decision: parsed.decision,
            selectedModel: parsed.selectedModel,
            usedKnowledgeEntriesJson: parsed.usedKnowledgeEntriesJson,
            generatedReply: parsed.generatedReply,
            replySent: parsed.replySent,
            escalated: parsed.escalated,
            error: parsed.error,
            retrievalMode: parsed.retrievalMode,
            retrievalDecision: parsed.retrievalDecision,
            escalationReason: parsed.escalationReason,
            knowledgeRuntimeVersion: parsed.knowledgeRuntimeVersion,
            shadowRetrievalSummaryJson: parsed.shadowRetrievalSummaryJson,
        })
        return { contract: RECORD_AI_DECISION_RESULT_V1, recorded: true }
    }
}
