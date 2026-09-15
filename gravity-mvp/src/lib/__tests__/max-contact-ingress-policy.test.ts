import { describe, expect, test } from 'vitest'

import { selectUniqueExactMaxSenderCandidate } from '../../modules/max-channel/internal/max-contact-ingress-policy'

describe('MAX exact sender chat selection', () => {
  test('returns no reuse for zero exact candidates', () => {
    expect(selectUniqueExactMaxSenderCandidate([])).toEqual({ status: 'no_match', candidateCount: 0 })
  })

  test('reuses exactly one exact candidate', () => {
    const candidate = { id: 'chat-1', lastMessageAt: new Date(0) }
    expect(selectUniqueExactMaxSenderCandidate([candidate])).toEqual({
      status: 'reuse', candidateCount: 1, candidate,
    })
  })

  test('two candidates are ambiguous regardless of recency or input order', () => {
    const old = { id: 'old', lastMessageAt: new Date(0) }
    const recent = { id: 'recent', lastMessageAt: new Date() }
    expect(selectUniqueExactMaxSenderCandidate([recent, old])).toEqual({
      status: 'ambiguous', candidateCount: 2, candidateIds: ['old', 'recent'],
    })
    expect(selectUniqueExactMaxSenderCandidate([old, recent]).status).toBe('ambiguous')
  })
})
