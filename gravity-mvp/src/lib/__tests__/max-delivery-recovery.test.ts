import { describe, expect, test } from 'vitest'
import { shouldMarkStuckOutboundFailed } from '@/lib/max-delivery-recovery'

describe('MAX delayed provider confirmation recovery', () => {
  test('keeps an unconfirmed MAX UI send pending instead of showing false retry', () => {
    expect(shouldMarkStuckOutboundFailed({
      channel: 'max',
      metadata: {
        maxDelivery: {
          status: 'send_requested',
          deliveryConfirmed: false,
          maxMessageId: null,
        },
      },
    })).toBe(false)
  })

  test('still recovers other channels and actual MAX failures', () => {
    expect(shouldMarkStuckOutboundFailed({
      channel: 'telegram',
      metadata: {},
    })).toBe(true)
    expect(shouldMarkStuckOutboundFailed({
      channel: 'max',
      metadata: { maxDelivery: { status: 'failed' } },
    })).toBe(true)
    expect(shouldMarkStuckOutboundFailed({
      channel: 'max',
      metadata: {},
    })).toBe(true)
  })

  test.each(['sending', 'queued', 'needs_review', 'reconciliation_required'])(
    'keeps durable MAX %s out of generic failed-message recovery',
    status => {
      expect(shouldMarkStuckOutboundFailed({
        channel: 'max', metadata: { maxDelivery: { status } },
      })).toBe(false)
    },
  )
})
