import { describe, expect, it } from 'vitest'
import {
  buildMaxDeliveryMetadata,
  canApplyMaxDeliveryTransition,
  isRealMaxMessageId,
  maxOperatorDeliveryError,
  maxDeliveryTargetStatus,
} from '@/lib/max-delivery-state'

describe('MAX outbound delivery state', () => {
  it('maps queue worker states to CRM MessageStatus', () => {
    expect(maxDeliveryTargetStatus('queued')).toBe('queued')
    expect(maxDeliveryTargetStatus('sending')).toBe('sent')
    expect(maxDeliveryTargetStatus('delivered')).toBe('delivered')
    expect(maxDeliveryTargetStatus('failed')).toBe('failed')
  })

  it('does not let a stale queued callback downgrade sent', () => {
    expect(canApplyMaxDeliveryTransition('sent', 'queued')).toBe(false)
  })

  it('does not downgrade delivered or read messages', () => {
    expect(canApplyMaxDeliveryTransition('delivered', 'failed')).toBe(false)
    expect(canApplyMaxDeliveryTransition('read', 'sent')).toBe(false)
  })

  it('accepts a late exact provider echo after timeout failure', () => {
    expect(canApplyMaxDeliveryTransition('failed', 'delivered')).toBe(true)
    expect(canApplyMaxDeliveryTransition('failed', 'sent')).toBe(false)
  })

  it('preserves reply metadata while recording a retryable failure', () => {
    const metadata = buildMaxDeliveryMetadata(
      { quotedMsgId: 'crm-quoted', maxDelivery: { quotedMsgId: 'd301quoted0001' } },
      {
        status: 'failed',
        queueId: 'maxq-1',
        attempt: 1,
        retryable: true,
        error: 'confirmation timeout',
        errorCode: 'MAX_CONFIRMATION_TIMEOUT',
      },
    )
    expect(metadata.quotedMsgId).toBe('crm-quoted')
    expect(metadata.errorCode).toBe('MAX_CONFIRMATION_TIMEOUT')
    expect(metadata.error).toBe('MAX не подтвердил доставку. Можно повторить отправку.')
    expect((metadata.maxDelivery as Record<string, unknown>).quotedMsgId).toBe('d301quoted0001')
    expect((metadata.maxDelivery as Record<string, unknown>).error).toBe('confirmation timeout')
  })

  it('clears retry errors only after durable provider confirmation', () => {
    const metadata = buildMaxDeliveryMetadata(
      {
        error: 'old timeout',
        errorCode: 'TIMEOUT',
        retryable: true,
        lastFailedAt: '2026-07-25T00:00:00.000Z',
      },
      {
        status: 'delivered',
        externalId: 'd301abcdef1234567890',
        retryable: false,
      },
    )
    expect(metadata).not.toHaveProperty('error')
    expect(metadata).not.toHaveProperty('errorCode')
    expect(metadata).not.toHaveProperty('retryable')
    expect((metadata.maxDelivery as Record<string, unknown>).deliveryConfirmed).toBe(true)
  })

  it('only treats real MAX provider ids as delivery confirmation', () => {
    expect(isRealMaxMessageId('d301abcdef1234567890')).toBe(true)
    expect(isRealMaxMessageId('max-dom-placeholder')).toBe(false)
  })

  it('keeps provider details technical and exposes a human retry message', () => {
    expect(maxOperatorDeliveryError({
      status: 'failed',
      errorCode: 'MAX_WS_DISCONNECTED',
      error: '{"code":"internal"}',
    })).toBe('Нет связи с MAX. Можно повторить отправку.')
  })
})
