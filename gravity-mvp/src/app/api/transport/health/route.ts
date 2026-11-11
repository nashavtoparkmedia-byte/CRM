import { NextResponse } from 'next/server'
import {
  transportRegistryHealthV1,
  type TransportConnectionEntryV1,
} from '@/modules/messaging/public/v1/transport-registry-health'

/**
 * GET /api/transport/health
 *
 * Public transport status. Read-only — does not modify any state.
 * Per channel only the ready and total connection counts and an aggregated
 * status: no connection id, instance id or error text, so the route can stay
 * ungated for ops probes. Details belong behind a staff session, not here.
 */
export async function GET() {
  try {
    const entries = transportRegistryHealthV1.getAllEntries()
    const summary = (channel: string) => {
      const connections = entries.filter((e: TransportConnectionEntryV1) => e.channel === channel)
      return {
        readyCount: connections.filter(e => e.state === 'ready').length,
        totalCount: connections.length,
      }
    }
    const status = entries.some(e => e.state === 'failed')
      ? 'error'
      : entries.some(e => e.state !== 'ready' && e.state !== 'stopped') ? 'degraded' : 'ok'

    return NextResponse.json({
      status,
      whatsapp: summary('whatsapp'),
      telegram: summary('telegram'),
      timestamp: new Date().toISOString(),
    })
  } catch {
    console.error('[transport/health] registry read failed')
    return NextResponse.json({ status: 'error', code: 'TRANSPORT_HEALTH_UNAVAILABLE' }, { status: 500 })
  }
}
