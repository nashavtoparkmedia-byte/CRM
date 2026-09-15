import { describe, expect, test, vi } from 'vitest'

import { createResolveContactLineageHandlerV1 } from './contact-lineage-handler'

describe('merged Contact lineage read-through', () => {
  test('resolves a loser chain and exposes all flattened survivor records', async () => {
    const redirects = new Map([
      ['loser-a', { id: 'loser-a', mergedIntoContactId: 'loser-b' }],
      ['loser-b', { id: 'loser-b', mergedIntoContactId: 'survivor' }],
      ['survivor', { id: 'survivor', mergedIntoContactId: null }],
    ])
    const handler = createResolveContactLineageHandlerV1({
      findRedirect: vi.fn(async id => redirects.get(id) ?? null),
      findMergedContactIds: vi.fn(async () => ['loser-a', 'loser-b']),
    })
    await expect(handler('loser-a')).resolves.toEqual({
      requestedContactId: 'loser-a',
      canonicalContactId: 'survivor',
      contactIds: ['loser-a', 'loser-b', 'survivor'],
    })
  })

  test('fails closed on redirect cycles', async () => {
    const handler = createResolveContactLineageHandlerV1({
      findRedirect: vi.fn(async id => ({ id, mergedIntoContactId: id === 'a' ? 'b' : 'a' })),
      findMergedContactIds: vi.fn(async () => []),
    })
    await expect(handler('a')).rejects.toThrow('CONTACT_MERGE_REDIRECT_CYCLE')
  })
})
