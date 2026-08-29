/**
 * In-process event bus for real-time call push to /api/calls/stream
 * subscribers.
 *
 * Two channels:
 *  - "global" — every event, used by the floating IncomingCallPopup.
 *  - per-call-id — used by the call detail page for one call.
 */

export type CallStreamEvent =
  | { type: 'incoming'; data: { callId: string; fromNumber: string; toNumber: string; driverId: string | null; contactId: string | null; displayName: string | null } }
  | { type: 'answered'; data: { callId: string; answeredAt: string; managerId: string | null } }
  | { type: 'ended'; data: { callId: string; endedAt: string; durationSec: number | null; status: string } }
  | { type: 'updated'; data: { callId: string; [key: string]: any } }

type Subscriber = (event: CallStreamEvent) => void

declare global {
  // eslint-disable-next-line no-var
  var __callStreamBus: { global: Set<Subscriber>; perCall: Map<string, Set<Subscriber>> } | undefined
}

const bus = globalThis.__callStreamBus ?? {
  global: new Set<Subscriber>(),
  perCall: new Map<string, Set<Subscriber>>(),
}
if (!globalThis.__callStreamBus) globalThis.__callStreamBus = bus

export function subscribeAllCalls(fn: Subscriber): () => void {
  bus.global.add(fn)
  return () => { bus.global.delete(fn) }
}

export function subscribeCall(callId: string, fn: Subscriber): () => void {
  if (!bus.perCall.has(callId)) bus.perCall.set(callId, new Set())
  bus.perCall.get(callId)!.add(fn)
  return () => {
    const subscribers = bus.perCall.get(callId)
    if (!subscribers) return
    subscribers.delete(fn)
    if (subscribers.size === 0) bus.perCall.delete(callId)
  }
}

export function broadcastCall(event: CallStreamEvent): void {
  for (const fn of bus.global) {
    try {
      fn(event)
    } catch (error) {
      console.warn('[callStreamBus] global subscriber threw:', (error as Error).message)
    }
  }
  const perCall = bus.perCall.get(event.data.callId)
  if (!perCall) return
  for (const fn of perCall) {
    try {
      fn(event)
    } catch (error) {
      console.warn('[callStreamBus] per-call subscriber threw:', (error as Error).message)
    }
  }
}
