import { NextResponse } from 'next/server'
import {
  transportRegistryHealthV1,
  type TransportConnectionEntryV1,
} from '@/modules/messaging/public/v1/transport-registry-health'

/**
 * GET /api/transport/health
 *
 * Returns runtime status of all transport connections from TransportRegistry.
 * Read-only — does not modify any state.
 */
export async function GET() {
  try {
    const entries = transportRegistryHealthV1.getAllEntries()
    const now = Date.now()

    const format = (e: TransportConnectionEntryV1) => ({
      id: e.connectionId,
      channel: e.channel,
      instanceId: e.instanceId ? e.instanceId.substring(0, 8) : null,
      state: e.state,
      lastSeen: e.lastSeen?.toISOString() || null,
      lastError: e.lastError,
      retryAttempt: e.retryAttempt,
      uptimeMs: e.readyAt ? now - e.readyAt.getTime() : null,
      reconnectInFlight: e.reconnectInFlight,
    })

    const whatsapp = entries.filter(e => e.channel === 'whatsapp').map(format)
    const telegram = entries.filter(e => e.channel === 'telegram').map(format)

    return NextResponse.json({
      whatsapp: { connections: whatsapp },
      telegram: { connections: telegram },
      timestamp: new Date().toISOString(),
    })
  } catch (err: any) {
    console.error('[transport/health] Error:', err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
