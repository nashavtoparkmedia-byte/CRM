import { describe, expect, it } from 'vitest'

import { KNOWLEDGE_RETRIEVAL_PROMPT_VERSION_V1 } from './knowledge-retrieval-version'

describe('AI Knowledge retrieval-version capability', () => {
    it('publishes the exact decision-log version token', () => {
        expect(KNOWLEDGE_RETRIEVAL_PROMPT_VERSION_V1).toBe('v1')
    })
})
