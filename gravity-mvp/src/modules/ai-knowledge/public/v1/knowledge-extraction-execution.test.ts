import { beforeEach, describe, expect, it, vi } from 'vitest'

const operations = vi.hoisted(() => ({
    runExtraction: vi.fn(),
}))

vi.mock('@/lib/ai/knowledge/Extractor', () => operations)

import { runQueuedKnowledgeExtractionV1 } from './knowledge-extraction-execution'

describe('AI Knowledge extraction execution capability', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('delegates only the queued owner job identifier', async () => {
        operations.runExtraction.mockResolvedValueOnce(undefined)

        await expect(runQueuedKnowledgeExtractionV1('kbj_1')).resolves.toBeUndefined()
        expect(operations.runExtraction).toHaveBeenCalledWith('kbj_1')
    })
})
