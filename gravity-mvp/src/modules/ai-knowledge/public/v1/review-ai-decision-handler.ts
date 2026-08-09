import { REVIEW_AI_DECISION_RESULT_V1, parseReviewAiDecisionCommandV1, type AiDecisionVerdictV1, type ReviewAiDecisionCommandV1, type ReviewAiDecisionResultV1 } from '../../../../contracts/ai-knowledge/v1'
export interface ReviewAiDecisionPersistencePortV1 { review(input: { logId: string; verdict: AiDecisionVerdictV1 }): Promise<void> }
export function createReviewAiDecisionHandlerV1(port: ReviewAiDecisionPersistencePortV1) {
    return async function reviewAiDecisionV1(command: ReviewAiDecisionCommandV1 | unknown): Promise<ReviewAiDecisionResultV1> {
        const parsed = parseReviewAiDecisionCommandV1(command)
        await port.review({ logId: parsed.logId, verdict: parsed.verdict })
        return { contract: REVIEW_AI_DECISION_RESULT_V1, reviewed: true }
    }
}
