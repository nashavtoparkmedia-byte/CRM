import { beforeEach, describe, expect, it, vi } from 'vitest'

const { retrieve, formatRetrievedFactsForPrompt } = vi.hoisted(() => ({
    retrieve: vi.fn(),
    formatRetrievedFactsForPrompt: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/Retriever', () => ({
    retrieve,
    formatRetrievedFactsForPrompt,
}))

import {
    formatKnowledgeFactsForPromptV1,
    previewKnowledgeRetrievalV1,
    retrieveKnowledgeForRuntimeV1,
} from './knowledge-retrieval'

describe('AI Knowledge retrieval boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('maps runtime mode to the existing shadow flag without exposing policy controls', async () => {
        const recentMessages = [{ role: 'user' as const, content: 'Вопрос' }]
        retrieve.mockResolvedValue({ items: [], trace: {} })

        await retrieveKnowledgeForRuntimeV1({ query: 'Вопрос', recentMessages, mode: 'shadow' })
        await retrieveKnowledgeForRuntimeV1({ query: 'Вопрос', recentMessages, mode: 'runtime' })

        expect(retrieve.mock.calls).toEqual([
            [{ query: 'Вопрос', recentMessages, shadowMode: true }],
            [{ query: 'Вопрос', recentMessages, shadowMode: false }],
        ])
    })

    it('keeps admin preview on forced runtime semantics', async () => {
        const result = { items: [], trace: { policy: { type: 'no_knowledge' } } }
        retrieve.mockResolvedValueOnce(result)

        await expect(previewKnowledgeRetrievalV1({ query: 'Диагностика' })).resolves.toBe(result)
        expect(retrieve).toHaveBeenCalledWith({ query: 'Диагностика', shadowMode: false })
    })

    it('delegates canonical-fact prompt formatting without projection drift', () => {
        const items = [{ id: 'knowledge-1' }]
        formatRetrievedFactsForPrompt.mockReturnValueOnce('1. Факт')

        expect(formatKnowledgeFactsForPromptV1(items as never)).toBe('1. Факт')
        expect(formatRetrievedFactsForPrompt).toHaveBeenCalledWith(items)
    })
})
