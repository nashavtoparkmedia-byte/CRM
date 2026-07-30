import { describe, expect, it } from 'vitest'
import { projectPersonalMaxDurableState } from '../personal-max-durable-projection'

const message = (clientMessageId: string, status = 'failed') => ({
  id: clientMessageId,
  clientMessageId,
  channel: 'max',
  direction: 'outbound',
  status,
  externalId: null,
  metadata: { retryable: true, maxDelivery: { status: 'failed' } },
})

describe('Personal MAX durable status projection', () => {
  it('replaces a stale failure with late exact provider confirmation', () => {
    const [projected] = projectPersonalMaxDurableState([message('client-one')], [{
      clientMessageId: 'client-one',
      dispatch: { state: 'provider_confirmed', providerMessageId: 'd3019fb24937cd40f5' },
    }])

    expect(projected).toMatchObject({
      status: 'delivered',
      externalId: 'd3019fb24937cd40f5',
      metadata: {
        retryable: false,
        maxDelivery: {
          status: 'provider_confirmed',
          deliveryConfirmed: true,
          maxMessageId: 'd3019fb24937cd40f5',
        },
      },
    })
  })

  it('projects unknown outcome as checking and blocks blind retry', () => {
    const [projected] = projectPersonalMaxDurableState([message('client-two')], [{
      clientMessageId: 'client-two',
      dispatch: { state: 'reconciliation_required', providerMessageId: null },
    }])

    expect(projected).toMatchObject({
      status: 'sent',
      metadata: { retryable: false, maxDelivery: { status: 'needs_review', deliveryConfirmed: false } },
    })
  })

  it('keeps separate identical sends isolated by clientMessageId', () => {
    const projected = projectPersonalMaxDurableState([
      { ...message('client-a'), content: 'Одинаковое сообщение' },
      { ...message('client-b'), content: 'Одинаковое сообщение' },
    ], [
      { clientMessageId: 'client-a', dispatch: { state: 'provider_confirmed', providerMessageId: 'd3019fb2492b3940f5' } },
      { clientMessageId: 'client-b', dispatch: { state: 'reconciliation_required', providerMessageId: null } },
    ])

    expect(projected.map(item => item.status)).toEqual(['delivered', 'sent'])
    expect(projected.map(item => item.metadata.maxDelivery.status)).toEqual(['provider_confirmed', 'needs_review'])
  })
})
