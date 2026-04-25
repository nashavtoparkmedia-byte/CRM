/**
 * In-process event bus for real-time message push to /api/messages/stream
 * subscribers (Phase 4 of chat speed work — replaces 3-second polling).
 *
 * Lives at module scope so it survives across React server-action invocations
 * within the same Next.js process. NOT durable — if the dev server restarts
 * subscribers reconnect via the EventSource onerror path; missed messages
 * are reconciled by the slow-polling fallback in useMessages.
 *
 * One bus per Node process is fine for our scale (single CRM dev/prod
 * instance). For horizontal scale we'd swap this for Redis pub/sub.
 */

type Subscriber = (event: { type: 'message'; data: any }) => void

declare global {
    // eslint-disable-next-line no-var
    var __messageStreamBus: Map<string, Set<Subscriber>> | undefined
}

const bus: Map<string, Set<Subscriber>> =
    globalThis.__messageStreamBus ?? new Map<string, Set<Subscriber>>()
if (!globalThis.__messageStreamBus) globalThis.__messageStreamBus = bus

export function subscribeChat(chatId: string, fn: Subscriber): () => void {
    if (!bus.has(chatId)) bus.set(chatId, new Set())
    bus.get(chatId)!.add(fn)
    return () => {
        const s = bus.get(chatId)
        if (!s) return
        s.delete(fn)
        if (s.size === 0) bus.delete(chatId)
    }
}

export function broadcastChatMessage(chatId: string, message: any): void {
    const s = bus.get(chatId)
    if (!s || s.size === 0) return
    const event = { type: 'message' as const, data: message }
    for (const fn of s) {
        try { fn(event) } catch (err) {
            console.warn('[messageStreamBus] subscriber threw:', (err as Error).message)
        }
    }
}

export function getActiveSubscriberCount(chatId?: string): number {
    if (chatId) return bus.get(chatId)?.size ?? 0
    let total = 0
    for (const s of bus.values()) total += s.size
    return total
}
