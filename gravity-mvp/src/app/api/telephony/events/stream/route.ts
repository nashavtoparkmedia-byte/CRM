import { onTelephonyEvent } from '@/lib/telephonyEventBus'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

export async function GET() {
  const encoder = new TextEncoder()

  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(': connected\n\n'))

      const unsubscribe = onTelephonyEvent((event) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch { /* stream closed */ }
      })

      const keepalive = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keepalive\n\n'))
        } catch {
          clearInterval(keepalive)
        }
      }, 30_000)

      const checkClosed = setInterval(() => {
        try {
          if (controller.desiredSize === null) {
            unsubscribe()
            clearInterval(keepalive)
            clearInterval(checkClosed)
          }
        } catch {
          unsubscribe()
          clearInterval(keepalive)
          clearInterval(checkClosed)
        }
      }, 5_000)
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
