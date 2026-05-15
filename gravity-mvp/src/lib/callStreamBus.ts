/**
 * In-process event bus for real-time call push to /api/calls/stream
 * subscribers. Mirrors messageStreamBus.ts.
 *
 * Two channels:
 *  - "global" — every event, used by the floating IncomingCallPopup that
 *    needs to know about all incoming calls regardless of which page the
 *    manager is on.
 *  - per-call-id — used by the call detail page to track status changes
 *    of a specific call.
 */

export type CallStreamEvent =
    | { type: 'incoming'; data: { callId: string; fromNumber: string; toNumber: string; driverId: string | null; contactId: string | null; displayName: string | null } }
    | { type: 'answered'; data: { callId: string; answeredAt: string; managerId: string | null } }
    | { type: 'ended'; data: { callId: string; endedAt: string; durationSec: number | null; status: string } }
    | { type: 'updated'; data: { callId: string; [k: string]: any } }

type Subscriber = (event: CallStreamEvent) => void

declare global {
    // eslint-disable-next-line no-var
    var __callStreamBus: { global: Set<Subscriber>; perCall: Map<string, Set<Subscriber>> } | undefined
}

const bus =
    globalThis.__callStreamBus ?? { global: new Set<Subscriber>(), perCall: new Map<string, Set<Subscriber>>() }
if (!globalThis.__callStreamBus) globalThis.__callStreamBus = bus

export function subscribeAllCalls(fn: Subscriber): () => void {
    bus.global.add(fn)
    return () => { bus.global.delete(fn) }
}

export function subscribeCall(callId: string, fn: Subscriber): () => void {
    if (!bus.perCall.has(callId)) bus.perCall.set(callId, new Set())
    bus.perCall.get(callId)!.add(fn)
    return () => {
        const s = bus.perCall.get(callId)
        if (!s) return
        s.delete(fn)
        if (s.size === 0) bus.perCall.delete(callId)
    }
}

export function broadcastCall(event: CallStreamEvent): void {
    for (const fn of bus.global) {
        try { fn(event) } catch (err) {
            console.warn('[callStreamBus] global subscriber threw:', (err as Error).message)
        }
    }
    const perCall = bus.perCall.get(event.data.callId)
    if (!perCall) return
    for (const fn of perCall) {
        try { fn(event) } catch (err) {
            console.warn('[callStreamBus] per-call subscriber threw:', (err as Error).message)
        }
    }
}
