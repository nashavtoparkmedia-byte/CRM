import { EventEmitter } from 'events'

export interface TelephonyEvent {
  type: 'call:ringing' | 'call:answered' | 'call:ended' | 'device:online' | 'device:offline'
  data: Record<string, unknown>
  timestamp: string
}

const bus = new EventEmitter()
bus.setMaxListeners(50)

export function emitTelephonyEvent(type: TelephonyEvent['type'], data: Record<string, unknown>) {
  bus.emit('telephony', { type, data, timestamp: new Date().toISOString() } satisfies TelephonyEvent)
}

export function onTelephonyEvent(listener: (event: TelephonyEvent) => void): () => void {
  bus.on('telephony', listener)
  return () => { bus.off('telephony', listener) }
}
