import { describe, expect, it } from 'vitest'
import { shouldProjectPersonalMaxMessage } from '../personal-max-message-visibility'

describe('Personal MAX inbound projection visibility', () => {
  it('quarantines an evidence-preserved browser history replay from live CRM projection', () => {
    expect(shouldProjectPersonalMaxMessage({
      metadata: {
        personalMaxIngressDisposition: {
          kind: 'history_replay',
          visibility: 'quarantined',
          evidencePreserved: true,
        },
      },
    })).toBe(false)
  })

  it('does not hide an ordinary inbound text whose content happens to be 3', () => {
    expect(shouldProjectPersonalMaxMessage({ metadata: { text: '3' } })).toBe(true)
  })

  it('hides only an evidence-preserved placeholder linked to one canonical provider id', () => {
    expect(shouldProjectPersonalMaxMessage({
      metadata: {
        source: 'dom_fallback',
        personalMaxProjection: {
          visibility: 'suppressed_duplicate',
          evidencePreserved: true,
          canonicalProviderMessageId: 'd3019fb1bb99243c87',
        },
      },
    })).toBe(false)
    expect(shouldProjectPersonalMaxMessage({
      metadata: {
        personalMaxProjection: {
          visibility: 'suppressed_duplicate',
          evidencePreserved: true,
        },
      },
    })).toBe(true)
  })

  it('fails open for malformed or unrelated metadata', () => {
    expect(shouldProjectPersonalMaxMessage({ metadata: null })).toBe(true)
    expect(shouldProjectPersonalMaxMessage({
      metadata: {
        personalMaxIngressDisposition: {
          kind: 'history_replay',
          visibility: 'quarantined',
          evidencePreserved: false,
        },
      },
    })).toBe(true)
  })
})
