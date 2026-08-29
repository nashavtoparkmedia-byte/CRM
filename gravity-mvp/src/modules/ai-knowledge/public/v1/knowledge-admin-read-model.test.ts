import { describe, expect, it } from 'vitest'

import { projectKnowledgeItemSourceAccessV1 } from './knowledge-source-access'

describe('AI Knowledge admin read model source visibility', () => {
    const full = {
        item: { id: 'item-1', title: 'Safe projection' },
        sources: [{ id: 'source-1', excerpt: 'private transcript' }],
    }

    it('redacts source excerpts by default at the public projection boundary', () => {
        expect(projectKnowledgeItemSourceAccessV1(full, {
            includeSourceExcerpts: false,
        })).toEqual({ item: full.item, sources: [] })
    })

    it('preserves sources only after an explicit application-edge authorization decision', () => {
        expect(projectKnowledgeItemSourceAccessV1(full, {
            includeSourceExcerpts: true,
        })).toEqual(full)
    })
})
