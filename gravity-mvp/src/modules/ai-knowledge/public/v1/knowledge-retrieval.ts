import {
    formatRetrievedFactsForPrompt,
    retrieve,
    type RetrievalTrace,
    type RetrievableItem,
    type RetrieveOutput,
} from '@/lib/ai/knowledge/Retriever'

export type {
    RetrievalTrace as KnowledgeRetrievalTraceV1,
    RetrievableItem as RetrievableKnowledgeItemV1,
    RetrieveOutput as KnowledgeRetrievalOutputV1,
}

export async function retrieveKnowledgeForRuntimeV1(input: {
    query: string
    recentMessages?: Array<{ role: 'user' | 'assistant'; content: string }>
    mode: 'shadow' | 'runtime'
}): Promise<RetrieveOutput> {
    return retrieve({
        query: input.query,
        recentMessages: input.recentMessages,
        shadowMode: input.mode === 'shadow',
    })
}

export async function previewKnowledgeRetrievalV1(input: {
    query: string
}): Promise<RetrieveOutput> {
    return retrieve({
        query: input.query,
        shadowMode: false,
    })
}

export function formatKnowledgeFactsForPromptV1(items: RetrievableItem[]): string {
    return formatRetrievedFactsForPrompt(items)
}
