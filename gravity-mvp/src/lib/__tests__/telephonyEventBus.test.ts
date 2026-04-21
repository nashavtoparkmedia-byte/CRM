import { describe, it, expect } from 'vitest'
import { emitTelephonyEvent, onTelephonyEvent, TelephonyEvent } from '../telephonyEventBus'

describe('telephonyEventBus', () => {
  it('emits events to listeners', () => {
    const received: TelephonyEvent[] = []
    const unsub = onTelephonyEvent((e) => received.push(e))
    emitTelephonyEvent('call:ringing', { callSessionId: 'test1' })
    expect(received).toHaveLength(1)
    expect(received[0].type).toBe('call:ringing')
    expect(received[0].data.callSessionId).toBe('test1')
    expect(received[0].timestamp).toBeTruthy()
    unsub()
  })

  it('unsubscribe stops delivery', () => {
    const received: TelephonyEvent[] = []
    const unsub = onTelephonyEvent((e) => received.push(e))
    unsub()
    emitTelephonyEvent('call:ended', { callSessionId: 'test2' })
    expect(received).toHaveLength(0)
  })

  it('all events have consistent structure', () => {
    const received: TelephonyEvent[] = []
    const unsub = onTelephonyEvent((e) => received.push(e))
    emitTelephonyEvent('device:online', { deviceId: 'd1' })
    emitTelephonyEvent('device:offline', { deviceId: 'd2' })
    for (const event of received) {
      expect(event).toHaveProperty('type')
      expect(event).toHaveProperty('data')
      expect(event).toHaveProperty('timestamp')
      expect(new Date(event.timestamp).getTime()).not.toBeNaN()
    }
    unsub()
  })
})
