import { describe, expect, test } from 'vitest'
import {
  buildMaxReplyStorage,
  reconcileMaxReplyMetadata,
} from '@/lib/max-reply-storage'

const raw = 'Парк Yoko\nОтветь в MAX на конкретное сообщение.\nОтветил'
const quote = 'Ответь в MAX на конкретное сообщение.'

describe('MAX inbound reply storage', () => {
  test('stores only the reply body and a CRM relation for a unique quoted message', () => {
    const result = buildMaxReplyStorage({
      rawContent: raw,
      replyBodyText: 'Ответил',
      replyQuoteText: quote,
      targets: [{ id: 'crm-original', externalId: null }],
    })

    expect(result.content).toBe('Ответил')
    expect(result.metadata).toEqual({
      quotedMsgId: 'crm-original',
      replyResolutionStatus: 'resolved',
    })
    expect(result.content).not.toContain('Парк Yoko')
    expect(result.content).not.toContain(quote)
  })

  test('preserves an exact provider target until a delayed original is stored', () => {
    const pending = buildMaxReplyStorage({
      rawContent: raw,
      replyBodyText: 'Ответил',
      replyQuoteText: quote,
      replyToExternalId: 'd3019f98f019667334',
      targets: [],
    })

    expect(pending.content).toBe('Ответил')
    expect(pending.metadata).toEqual({
      replyToExternalId: 'd3019f98f019667334',
      unresolvedReplyQuoteText: quote,
      replyResolutionStatus: 'pending_original',
    })

    expect(reconcileMaxReplyMetadata(pending.metadata, {
      id: 'crm-original-late',
      externalId: 'd3019f98f019667334',
    })).toEqual({
      replyToExternalId: 'd3019f98f019667334',
      quotedMsgId: 'crm-original-late',
      replyResolutionStatus: 'resolved',
    })
  })

  test('does not split an ambiguous provider-unverified multiline message', () => {
    const result = buildMaxReplyStorage({
      rawContent: raw,
      replyBodyText: 'Ответил',
      replyQuoteText: quote,
      targets: [
        { id: 'one', externalId: null },
        { id: 'two', externalId: null },
      ],
    })

    expect(result.content).toBe(raw)
    expect(result.metadata).toEqual({
      unresolvedReplyQuoteText: quote,
      replyResolutionStatus: 'ambiguous_or_missing',
    })
  })

  test('direct provider reply relation resolves to exact existing target', () => {
    const result = buildMaxReplyStorage({
      rawContent: 'Ответил',
      replyToExternalId: 'd3019f98f019667334',
      targets: [{
        id: 'crm-original',
        externalId: 'd3019f98f019667334',
      }],
    })

    expect(result.content).toBe('Ответил')
    expect(result.metadata).toEqual({
      replyToExternalId: 'd3019f98f019667334',
      quotedMsgId: 'crm-original',
      replyResolutionStatus: 'resolved',
    })
  })
})
