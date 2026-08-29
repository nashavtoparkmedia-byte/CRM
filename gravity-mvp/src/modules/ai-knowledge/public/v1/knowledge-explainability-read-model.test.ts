import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDecisionExplainability } = vi.hoisted(() => ({
    getDecisionExplainability: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/explainability', () => ({
    getDecisionExplainability,
}))

import { getKnowledgeDecisionExplainabilityV1 } from './knowledge-explainability-read-model'

describe('AI Knowledge explainability read model', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('retains source evidence only for an explicitly authorized application edge', async () => {
        const bundle = {
            decision: { id: 'decision-1' },
            userMessage: null,
            knowledgeUsages: [],
            sources: [{ id: 'source-1', excerpt: 'raw manager message' }],
            auditAfter: [],
        }
        getDecisionExplainability.mockResolvedValueOnce(bundle)

        await expect(getKnowledgeDecisionExplainabilityV1('decision-1', {
            includeSourceExcerpts: true,
        })).resolves.toBe(bundle)
    })

    it('removes all source rows while preserving the rest of the explainability bundle', async () => {
        const bundle = {
            decision: { id: 'decision-2' },
            userMessage: { id: 'message-1' },
            knowledgeUsages: [{ id: 'usage-1' }],
            sources: [{ id: 'source-2', excerpt: 'sensitive excerpt' }],
            auditAfter: [{ id: 'audit-1' }],
        }
        getDecisionExplainability.mockResolvedValueOnce(bundle)

        await expect(getKnowledgeDecisionExplainabilityV1('decision-2', {
            includeSourceExcerpts: false,
        })).resolves.toEqual({
            decision: bundle.decision,
            userMessage: bundle.userMessage,
            knowledgeUsages: bundle.knowledgeUsages,
            sources: [],
            auditAfter: bundle.auditAfter,
        })
        expect(getDecisionExplainability).toHaveBeenCalledWith('decision-2')
    })
})
