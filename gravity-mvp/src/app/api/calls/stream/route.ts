import { NextRequest } from 'next/server'
import { subscribeAllCalls, type CallStreamEvent } from '@/modules/calling/internal/call-stream'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/calls/stream — Server-Sent Events for all call lifecycle changes.
 *
 * Mounted in the CRM shell once, drives the incoming-call popup and the
 * "active call" indicator in the call toolbar. Per-call detail pages can
 * filter client-side by callId.
 */
export async function GET(_req: NextRequest) {
    const encoder = new TextEncoder()
    let unsubscribe: (() => void) | null = null

    const stream = new ReadableStream({
        start(controller) {
            const send = (event: CallStreamEvent | { type: 'connected' } | { type: 'ping' }) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
                } catch {
                    // controller closed — subscription will be torn down by cancel()
                }
            }

            send({ type: 'connected' })

            unsubscribe = subscribeAllCalls(event => send(event))

            // Keepalive every 25s — proxies tend to drop idle SSE connections at 30s
            const keepalive = setInterval(() => send({ type: 'ping' }), 25000)
            // Stash so cancel() can clean up
            ;(controller as any)._keepalive = keepalive
        },
        cancel() {
            if (unsubscribe) unsubscribe()
            const ka = (this as any)._keepalive
            if (ka) clearInterval(ka)
        },
    })

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        },
    })
}
