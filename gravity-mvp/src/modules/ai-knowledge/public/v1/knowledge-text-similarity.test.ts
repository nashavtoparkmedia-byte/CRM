import { describe, expect, it } from 'vitest'

import { compareKnowledgeTextSimilarityV1 } from './knowledge-text-similarity'

describe('AI Knowledge text-similarity capability', () => {
    it('retains normalized trigram similarity semantics', () => {
        expect(compareKnowledgeTextSimilarityV1('Комиссия 4,5%', 'комиссия 4 5')).toBe(1)
        expect(compareKnowledgeTextSimilarityV1('комиссия', 'автомобиль')).toBe(0)
        expect(compareKnowledgeTextSimilarityV1('', '')).toBe(0)
    })
})
