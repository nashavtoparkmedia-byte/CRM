import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    runCoach: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/coach', () => ({ runCoach: operations.runCoach }))

import { runKnowledgeCoachV1 } from './knowledge-coach'

describe('AI Knowledge coach capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates the exact provider request and reviewed item set', async () => {
        const options = {
            provider: 'anthropic',
            model: 'model-1',
            apiKey: 'secret',
            originalDraft: 'old',
            correctedText: 'new',
            items: [{ id: 'item-1', title: 'Title', canonicalStatement: 'Fact' }],
        }
        const result = { suggestions: [], onlyStyleChange: true }
        operations.runCoach.mockResolvedValueOnce(result)

        await expect(runKnowledgeCoachV1(options)).resolves.toBe(result)
        expect(operations.runCoach).toHaveBeenCalledWith(options)
    })
})
