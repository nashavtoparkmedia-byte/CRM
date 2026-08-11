import {
    runCoach,
    type CoachResult,
    type CoachSuggestion,
    type KnowledgeItemForCoach,
} from '@/lib/ai/knowledge/coach'

export type {
    CoachResult as KnowledgeCoachResultV1,
    CoachSuggestion as KnowledgeCoachSuggestionV1,
    KnowledgeItemForCoach as KnowledgeCoachItemV1,
}

export async function runKnowledgeCoachV1(options: {
    provider: string
    model: string
    apiKey: string
    originalDraft: string
    correctedText: string
    items: KnowledgeItemForCoach[]
}): Promise<CoachResult> {
    return runCoach(options)
}
