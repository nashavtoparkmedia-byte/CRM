/**
 * Server-Sent Events endpoint — Phase 4 of chat speed work.
 *
 * Replaces the 3-second polling in useMessages with a long-lived
 * connection: when a new message lands in the bus for THIS chatId, we
 * push it down the stream and the UI prepends it instantly.
 *
 * Stream format (SSE):
 *   data: {"type":"connected"}\n\n               // on open
 *   : ping\n\n                                   // every 25s, comment line
 *   data: {"type":"message","data":{...}}\n\n    // each new message
 *
 * Browser EventSource reconnects automatically on disconnect, so a
 * server restart or network blip is transparent.
 */
import { NextRequest } from 'next/server'
import { subscribeChat } from '@/lib/messageStreamBus'

// Force Node runtime — SSE relies on long-lived ReadableStream which
// behaves cleanly under Node, not Edge.
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(
    req: NextRequest,
    { params }: { params: Promise<{ chatId: string }> },
) {
    const { chatId } = await params
    if (!chatId) {
        return new Response('chatId required', { status: 400 })
    }

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
        start(controller) {
            const send = (payload: object) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`))
                } catch {
                    // controller already closed — ignore
                }
            }
            const sendComment = (text: string) => {
                try {
                    controller.enqueue(encoder.encode(`: ${text}\n\n`))
                } catch { /* closed */ }
            }

            // Initial handshake
            send({ type: 'connected', chatId })

            // Subscribe to bus
            const unsub = subscribeChat(chatId, (ev) => send(ev))

            // Keepalive — many proxies / dev tunnels close idle connections
            // around 30-60s. SSE comments are ignored by EventSource API.
            const pingInterval = setInterval(() => sendComment('ping'), 25_000)

            // Cleanup on client abort
            req.signal.addEventListener('abort', () => {
                clearInterval(pingInterval)
                unsub()
                try { controller.close() } catch { /* already closed */ }
            })
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache, no-store, no-transform',
            'Connection': 'keep-alive',
            // Tell Next/proxies not to buffer
            'X-Accel-Buffering': 'no',
        },
    })
}
