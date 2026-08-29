import { afterEach, describe, expect, it, vi } from 'vitest'

import { broadcastCall, subscribeAllCalls, subscribeCall } from './call-stream'

const cleanup: Array<() => void> = []
afterEach(() => {
  cleanup.splice(0).forEach((unsubscribe) => unsubscribe())
  vi.restoreAllMocks()
})

describe('Calling internal stream', () => {
  it('delivers globally and by call id, then honors unsubscribe', () => {
    const global = vi.fn()
    const perCall = vi.fn()
    cleanup.push(subscribeAllCalls(global), subscribeCall('call-boundary-test', perCall))
    const event = { type: 'ended' as const, data: { callId: 'call-boundary-test', endedAt: '2026-08-11T00:00:00.000Z', durationSec: 10, status: 'completed' } }

    broadcastCall(event)
    expect(global).toHaveBeenCalledWith(event)
    expect(perCall).toHaveBeenCalledWith(event)

    cleanup.splice(0).forEach((unsubscribe) => unsubscribe())
    broadcastCall(event)
    expect(global).toHaveBeenCalledOnce()
    expect(perCall).toHaveBeenCalledOnce()
  })

  it('isolates a throwing subscriber from the remaining subscribers', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const survivor = vi.fn()
    cleanup.push(
      subscribeAllCalls(() => { throw new Error('subscriber failed') }),
      subscribeAllCalls(survivor),
    )
    const event = { type: 'updated' as const, data: { callId: 'call-throw-test', status: 'processing' } }

    expect(() => broadcastCall(event)).not.toThrow()
    expect(survivor).toHaveBeenCalledWith(event)
  })
})
