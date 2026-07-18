import { beforeEach, describe, expect, test, vi } from 'vitest'

import {
  getOrCreateReachabilityDecision,
  resetReachabilityDecisionCacheForTests,
} from '@/lib/reachability-decision-cache'

describe('reachability decision cache', () => {
  beforeEach(() => {
    resetReachabilityDecisionCacheForTests()
  })

  test('returns a fresh result from cache without invoking the provider loader', async () => {
    let nowMs = 1_000
    const load = vi.fn().mockResolvedValue({ value: 'confirmed', ttlMs: 10_000 })
    const first = await getOrCreateReachabilityDecision({
      key: 'whatsapp:+79222155750',
      now: () => nowMs,
      load,
    })
    nowMs += 1_000
    const second = await getOrCreateReachabilityDecision({
      key: 'whatsapp:+79222155750',
      now: () => nowMs,
      load,
    })
    expect(first.source).toBe('live')
    expect(second.source).toBe('cache')
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('coalesces parallel decisions for the same phone and provider', async () => {
    let resolveLoader!: (value: { value: string; ttlMs: number }) => void
    const load = vi.fn(() => new Promise<{ value: string; ttlMs: number }>(resolve => {
      resolveLoader = resolve
    }))
    const first = getOrCreateReachabilityDecision({
      key: 'max:+79222155750',
      load,
    })
    const second = getOrCreateReachabilityDecision({
      key: 'max:+79222155750',
      load,
    })
    resolveLoader({ value: 'confirmed', ttlMs: 10_000 })

    const [firstResult, secondResult] = await Promise.all([first, second])
    expect(firstResult.source).toBe('live')
    expect(secondResult.source).toBe('coalesced')
    expect(load).toHaveBeenCalledTimes(1)
  })

  test('runs one new decision after TTL expiry', async () => {
    let nowMs = 1_000
    const load = vi.fn().mockResolvedValue({ value: 'confirmed', ttlMs: 100 })
    await getOrCreateReachabilityDecision({
      key: 'telegram:+79222155750',
      now: () => nowMs,
      load,
    })
    nowMs = 1_101
    const next = await getOrCreateReachabilityDecision({
      key: 'telegram:+79222155750',
      now: () => nowMs,
      load,
    })
    expect(next.source).toBe('live')
    expect(load).toHaveBeenCalledTimes(2)
  })
})
